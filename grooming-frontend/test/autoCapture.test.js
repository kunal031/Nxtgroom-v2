import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AUTO_CAPTURE_CONFIRMATIONS,
  AUTO_CAPTURE_COOLDOWN_MS,
  AUTO_CAPTURE_FALLBACK_ATTEMPTS,
  autoCaptureFallbackDue,
  autoCaptureReady,
  shutterEnabled,
} from '../src/lib/fullBodyDetector.ts';

/**
 * When the camera takes a photograph by itself.
 *
 * Every automatic capture costs a recognition call, a vision call and a stored
 * photograph of a person, and nobody is looking at the frame before it fires.
 * The rule is therefore stricter than the one behind the manual shutter, and
 * these tests exist to keep the two from being collapsed into one.
 */

test('only a confident whole-body frame fires the camera', () => {
  assert.equal(autoCaptureReady('FULL_BODY', AUTO_CAPTURE_CONFIRMATIONS), true);
  for (const verdict of ['PARTIAL', 'TOO_FAR', 'NO_PERSON', 'MULTIPLE_PEOPLE', 'UNAVAILABLE']) {
    assert.equal(
      autoCaptureReady(verdict, AUTO_CAPTURE_CONFIRMATIONS),
      false,
      `${verdict} must not fire an automatic capture`,
    );
  }
});

test('auto-capture is stricter than the manual shutter, deliberately', () => {
  // A person pressing the button has judged the frame themselves, so the manual
  // gate stays permissive. Collapsing the two would either auto-submit
  // half-framed photos or stop somebody capturing a usable one by hand.
  for (const verdict of ['PARTIAL', 'TOO_FAR', 'UNAVAILABLE']) {
    assert.equal(shutterEnabled(verdict, 0, false), true, `${verdict} stays manually capturable`);
    assert.equal(autoCaptureReady(verdict, 99), false, `${verdict} never fires automatically`);
  }
});

test('a good frame has to hold before it fires', () => {
  // Somebody walking past produces one or two good readings, not three.
  for (let frames = 0; frames < AUTO_CAPTURE_CONFIRMATIONS; frames += 1) {
    assert.equal(autoCaptureReady('FULL_BODY', frames), false, `${frames} readings is not enough`);
  }
  assert.equal(autoCaptureReady('FULL_BODY', AUTO_CAPTURE_CONFIRMATIONS), true);
});

test('holding longer than required still fires', () => {
  assert.equal(autoCaptureReady('FULL_BODY', AUTO_CAPTURE_CONFIRMATIONS + 20), true);
});

test('multiple people never fire, however long they stand there', () => {
  // There would be no way to tell whose attendance it was.
  assert.equal(autoCaptureReady('MULTIPLE_PEOPLE', 1_000), false);
});

test('the manual shutter is offered once a run of frames is unusable', () => {
  assert.equal(autoCaptureFallbackDue(0), false);
  assert.equal(autoCaptureFallbackDue(AUTO_CAPTURE_FALLBACK_ATTEMPTS - 1), false);
  assert.equal(autoCaptureFallbackDue(AUTO_CAPTURE_FALLBACK_ATTEMPTS), true);
  assert.equal(autoCaptureFallbackDue(AUTO_CAPTURE_FALLBACK_ATTEMPTS + 50), true);
});

test('the fallback arrives in a few seconds, not after a minute of waiting', () => {
  // At five readings a second. A strict rule that cannot be satisfied is the
  // thing standing between somebody and their attendance, so the wait is short.
  const seconds = AUTO_CAPTURE_FALLBACK_ATTEMPTS / 5;
  assert.ok(seconds >= 3 && seconds <= 8, `fallback after ${seconds}s should be a few seconds`);
});

test('the cooldown is long enough that one person is not photographed repeatedly', () => {
  // Without it a person standing in front of the tablet is captured every
  // 200ms, and each frame costs a recognition call, a vision call and an object.
  assert.ok(AUTO_CAPTURE_COOLDOWN_MS >= 5_000);
  // And short enough that the next person does not queue behind it.
  assert.ok(AUTO_CAPTURE_COOLDOWN_MS <= 15_000);
});

test('the hold is over half a second but under two', () => {
  // Long enough to exclude a passer-by, short enough not to feel like waiting.
  const ms = (AUTO_CAPTURE_CONFIRMATIONS / 5) * 1_000;
  assert.ok(ms >= 500 && ms <= 2_000, `${ms}ms hold should feel immediate`);
});
