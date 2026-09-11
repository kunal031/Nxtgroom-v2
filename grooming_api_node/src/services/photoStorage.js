import crypto from "node:crypto";
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { incrementMetric } from "./telemetry.js";

/**
 * Check-in and check-out photos live in Cloudflare R2, not MongoDB.
 *
 * Storing binary in the database inflates every document toward the 16 MB BSON
 * ceiling and drags the whole payload through backups and replication. R2 keeps
 * the database small and charges no egress, and the attendance record holds
 * only an object key.
 *
 * The bucket is private. Viewing a photo goes through a short-lived presigned
 * URL rather than a public link, because these are photographs of people and a
 * public URL would stay readable by anyone it was ever forwarded to.
 */

let client = null;
let clientFingerprint = "";

function config() {
  return {
    endpoint: process.env.R2_ENDPOINT,
    bucket: process.env.R2_BUCKET,
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  };
}

export function isPhotoStorageConfigured() {
  const { endpoint, bucket, accessKeyId, secretAccessKey } = config();
  return Boolean(endpoint && bucket && accessKeyId && secretAccessKey);
}

export async function checkPhotoStorageConnection() {
  if (!isPhotoStorageConfigured()) return false;
  try {
    await getClient().send(new HeadBucketCommand({ Bucket: config().bucket }));
    return true;
  } catch {
    return false;
  }
}

/**
 * Rebuilds the client when credentials change. Caching on the endpoint alone
 * would keep using a rotated key until the process restarted.
 */
function getClient() {
  const { endpoint, accessKeyId, secretAccessKey } = config();
  const fingerprint = `${endpoint}|${accessKeyId}`;
  if (!client || clientFingerprint !== fingerprint) {
    client = new S3Client({
      // R2 has no regions; the S3 SDK still requires the field and expects
      // this literal value.
      region: "auto",
      endpoint,
      credentials: { accessKeyId, secretAccessKey },
    });
    clientFingerprint = fingerprint;
  }
  return client;
}

const EXTENSIONS = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

/**
 * Object key for one photo. Date-partitioned so the bucket browser stays
 * navigable, and suffixed with random bytes so a key can never be guessed
 * from the instructor id and timestamp alone.
 */
export function buildPhotoKey({ instructorId, kind, mimeType, now = new Date() }) {
  const extension = EXTENSIONS[mimeType] || "jpg";
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  const day = String(now.getUTCDate()).padStart(2, "0");
  const safeInstructor = String(instructorId).replace(/[^A-Za-z0-9_-]/g, "");
  const unique = crypto.randomBytes(8).toString("hex");
  return `attendance/${year}/${month}/${day}/${safeInstructor}-${kind}-${unique}.${extension}`;
}

/**
 * Object key for one instructor's reference face photo.
 *
 * Deliberately outside the `attendance/` prefix. The retention purge walks
 * attendance records and deletes the photo keys they hold, and the orphan
 * reconciler lists `attendance/` and removes anything no record points at — a
 * reference photo would match the second rule and be deleted roughly two
 * months after enrollment. Recognition would keep working, because the face
 * vector lives at Rekognition rather than in R2, so the only visible symptom
 * would be a missing image in the admin screen, two months late, with nothing
 * logged. Keeping these under their own prefix is what prevents that.
 */
export function buildReferencePhotoKey({ instructorId, mimeType, now = new Date() }) {
  const extension = EXTENSIONS[mimeType] || "jpg";
  const safeInstructor = String(instructorId).replace(/[^A-Za-z0-9_-]/g, "");
  const unique = crypto.randomBytes(8).toString("hex");
  // Timestamped so a replaced photo never collides with the one it replaces,
  // which matters because the old object is deleted after the new one is
  // written rather than before.
  return `reference/${safeInstructor}/${now.getTime()}-${unique}.${extension}`;
}

/**
 * Uploads one photo. Returns { stored: false, reason } instead of throwing so
 * a storage outage cannot fail an attendance submission that is otherwise
 * valid; the caller records the reason and the check-in still succeeds.
 */
export async function uploadPhoto({ key, body, mimeType, metadata = {} }) {
  if (!isPhotoStorageConfigured()) {
    return { stored: false, reason: "storage_not_configured" };
  }
  try {
    await getClient().send(
      new PutObjectCommand({
        Bucket: config().bucket,
        Key: key,
        Body: body,
        ContentType: mimeType,
        // Values must be ASCII strings; numbers and undefined are dropped.
        Metadata: Object.fromEntries(
          Object.entries(metadata)
            .filter(([, value]) => value !== undefined && value !== null)
            .map(([name, value]) => [name, String(value)])
        ),
      })
    );
    incrementMetric("r2_upload_success_total");
    return { stored: true, key };
  } catch (error) {
    incrementMetric("r2_upload_failures_total");
    console.error(`R2 upload failed for ${key}: ${error?.name || "Error"}`);
    return { stored: false, reason: error?.name || "upload_failed" };
  }
}

/** Time-limited read URL. Default 15 minutes: long enough to open a record, short enough that a copied link goes stale. */
export async function getPhotoUrl(key, { expiresIn = 900 } = {}) {
  if (!isPhotoStorageConfigured() || !key) return null;
  try {
    return await getSignedUrl(
      getClient(),
      new GetObjectCommand({ Bucket: config().bucket, Key: key }),
      { expiresIn }
    );
  } catch (error) {
    console.error(`R2 presign failed for ${key}: ${error?.name || "Error"}`);
    return null;
  }
}

/**
 * Downloads a photo as a Buffer for analysis. R2 is the only copy of the
 * image, so the worker reads from here rather than from MongoDB.
 */
export async function downloadPhoto(key) {
  if (!isPhotoStorageConfigured()) throw new Error("Photo storage is not configured");
  if (!key) throw new Error("Photo key is required");
  const response = await getClient().send(
    new GetObjectCommand({ Bucket: config().bucket, Key: key })
  );
  if (!response.Body) throw new Error(`Photo ${key} has no content`);
  // transformToByteArray buffers the whole object, which is correct here:
  // photos are capped at a few hundred KB after normalization.
  const bytes = await response.Body.transformToByteArray();
  return {
    buffer: Buffer.from(bytes),
    mimeType: response.ContentType || "image/jpeg",
  };
}

/** Removes a photo, used when its retention window closes. */
export async function deletePhoto(key) {
  if (!isPhotoStorageConfigured() || !key) return { deleted: false };
  try {
    await getClient().send(
      new DeleteObjectCommand({ Bucket: config().bucket, Key: key })
    );
    return { deleted: true };
  } catch (error) {
    console.error(`R2 delete failed for ${key}: ${error?.name || "Error"}`);
    return { deleted: false, reason: error?.name || "delete_failed" };
  }
}

export async function listPhotoObjects({ continuationToken, maxKeys = 200 } = {}) {
  if (!isPhotoStorageConfigured()) return { objects: [], nextToken: null };
  const response = await getClient().send(new ListObjectsV2Command({
    Bucket: config().bucket,
    Prefix: "attendance/",
    MaxKeys: Math.max(1, Math.min(1000, maxKeys)),
    ...(continuationToken ? { ContinuationToken: continuationToken } : {}),
  }));
  return {
    objects: (response.Contents || []).map((item) => ({
      key: item.Key,
      lastModified: item.LastModified || null,
    })).filter((item) => item.key),
    nextToken: response.IsTruncated ? response.NextContinuationToken || null : null,
  };
}
