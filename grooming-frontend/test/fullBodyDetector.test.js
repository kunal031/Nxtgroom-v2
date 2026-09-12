import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MIN_BODY_SPAN_RATIO,
  OVERRIDE_AFTER_MS,
  readKeypoints,
  readPoses,
  shutterEnabled,
  stabilizeFrameReading,
  STEADY_MS,
} from '../src/lib/fullBodyDetector.ts';

const point = (name, score) => ({ name, score });
const wholePerson = [point('nose', 0.9), point('left_ankle', 0.8), point('right_ankle', 0.8)];
const framedPerson = [
  { name: 'nose', score: 0.9, x: 100, y: 80 },
  { name: 'left_shoulder', score: 0.9, x: 80, y: 180 },
  { name: 'right_shoulder', score: 0.9, x: 120, y: 180 },
  { name: 'left_ankle', score: 0.8, x: 90, y: 820 },
  { name: 'right_ankle', score: 0.8, x: 110, y: 820 },
];

/**
 * The gate exists because a head-and-shoulders photograph leaves eleven of
 * twenty checkpoints unassessable. It must never become a reason somebody
 * cannot check in, so detector infrastructure failures open the shutter. A
 * working detector still blocks empty frames and multiple people.
 */

test('a whole person is head and both ankles, nothing else', () => {
  assert.equal(readKeypoints(wholePerson).verdict, 'FULL_BODY');
  assert.equal(readKeypoints(wholePerson).guidance, null, 'a correct frame needs no commentary');
});

test('one ankle is not a full-body photograph', () => {
  // Someone standing at an angle, or with one foot just out of frame, has not
  // given the report anything to judge their footwear by.
  const oneFoot = [point('nose', 0.9), point('left_ankle', 0.8), point('right_ankle', 0.05)];
  assert.equal(readKeypoints(oneFoot).verdict, 'PARTIAL');
  assert.match(readKeypoints(oneFoot).guidance, /step back/i);
});

test('a distant whole person is still a whole person', () => {
  // Half the height of the framed subject, which the previous span gate called
  // TOO_FAR. Head and both ankles are in shot, so the photograph shows
  // everything the grooming report judges, and the camera fires.
  //
  // The gate was removed because it could contradict the ankle requirement:
  // close enough to fill the frame put the feet below a chest-height camera,
  // far enough back for the feet to appear dropped the span under the
  // threshold, and on many mountings no distance satisfied both.
  const distant = framedPerson.map((keypoint) => ({
    ...keypoint,
    y: 300 + ((keypoint.y - 80) * 0.5),
  }));
  assert.equal(readKeypoints(distant, 1000).verdict, 'FULL_BODY');
  assert.equal(readKeypoints(distant, 1000).guidance, null);
  assert.equal(MIN_BODY_SPAN_RATIO, 0, 'no minimum subject size is enforced');
});

test('a large head-to-feet subject is ready', () => {
  assert.equal(readKeypoints(framedPerson, 1000).verdict, 'FULL_BODY');
});

test('the live check reads each wrist relative to its shoulder', () => {
  const reading = readKeypoints([
    ...framedPerson,
    { name: 'left_wrist', score: 0.9, x: 70, y: 100 },
    { name: 'right_wrist', score: 0.9, x: 130, y: 400 },
  ], 1000);
  assert.deepEqual(reading.poseSignals, {
    leftWrist: 'RAISED',
    rightWrist: 'LOWERED',
  });
});

test('multiple people are rejected even when one is only partly visible', () => {
  const backgroundFace = [
    { name: 'nose', score: 0.8, x: 500, y: 200 },
    { name: 'left_eye', score: 0.8, x: 490, y: 190 },
    { name: 'right_eye', score: 0.8, x: 510, y: 190 },
  ];
  const reading = readPoses([
    { score: 0.9, keypoints: framedPerson },
    { score: 0.6, keypoints: backgroundFace },
  ], 1000);
  assert.equal(reading.verdict, 'MULTIPLE_PEOPLE');
  assert.match(reading.guidance, /only one person/i);
});

test('overlapping duplicate poses from the model count as one person', () => {
  const duplicate = framedPerson.map((keypoint) => ({
    ...keypoint,
    x: keypoint.x + 2,
    y: keypoint.y + 2,
  }));
  assert.equal(readPoses([
    { score: 0.9, keypoints: framedPerson },
    { score: 0.4, keypoints: duplicate },
  ], 1000).verdict, 'FULL_BODY');
});

test('a weak four-point model guess is not called another person', () => {
  const weakGuess = [
    { name: 'left_shoulder', score: 0.4, x: 500, y: 300 },
    { name: 'right_shoulder', score: 0.4, x: 540, y: 300 },
    { name: 'left_hip', score: 0.4, x: 505, y: 400 },
    { name: 'right_hip', score: 0.4, x: 535, y: 400 },
  ];
  assert.equal(readPoses([
    { score: 0.9, keypoints: framedPerson },
    { score: 0.2, keypoints: weakGuess },
  ], 1000).verdict, 'FULL_BODY');
});

test('camera feedback changes only after consecutive matching readings', () => {
  const empty = { verdict: 'NO_PERSON', guidance: 'Step into the frame' };
  const ready = { verdict: 'FULL_BODY', guidance: null };
  let state = { reading: empty, candidate: null, candidateCount: 0 };
  state = stabilizeFrameReading(state, ready);
  assert.equal(state.reading.verdict, 'NO_PERSON');
  state = stabilizeFrameReading(state, ready);
  assert.equal(state.reading.verdict, 'NO_PERSON');
  state = stabilizeFrameReading(state, ready);
  assert.equal(state.reading.verdict, 'FULL_BODY');
  state = stabilizeFrameReading(state, empty);
  assert.equal(state.reading.verdict, 'FULL_BODY', 'one noisy frame must not flash the outline');
});

test('a low-confidence keypoint is a guess, not a sighting', () => {
  const uncertain = [point('nose', 0.9), point('left_ankle', 0.2), point('right_ankle', 0.2)];
  assert.equal(readKeypoints(uncertain).verdict, 'PARTIAL');
});

test('the instruction names what to change', () => {
  // "Step back" and "move the camera down" are opposite corrections, and
  // giving the wrong one sends somebody further from a usable photograph.
  const feetOnly = [point('left_ankle', 0.8), point('right_ankle', 0.8)];
  assert.match(readKeypoints(feetOnly).guidance, /head is out of frame/i);

  const headOnly = [point('nose', 0.9)];
  assert.match(readKeypoints(headOnly).guidance, /feet are not in frame/i);
});

test('an empty frame asks the person to step into it', () => {
  assert.equal(readKeypoints([]).verdict, 'NO_PERSON');
  assert.equal(readKeypoints(undefined).verdict, 'NO_PERSON');
  assert.match(readKeypoints([]).guidance, /step into the frame/i);
});

test('the shutter opens immediately for a detected person', () => {
  assert.equal(shutterEnabled('FULL_BODY', 0, false), true);
  assert.equal(shutterEnabled('PARTIAL', 0, false), true);
  assert.equal(shutterEnabled('TOO_FAR', 0, false), true);
});

test('framing recommendations do not block attendance capture', () => {
  assert.equal(shutterEnabled('PARTIAL', 10_000, false), true);
  assert.equal(shutterEnabled('TOO_FAR', 10_000, false), true);
  assert.equal(shutterEnabled('NO_PERSON', 10_000, false), false);
});

test('multiple people can never be bypassed with the accessibility override', () => {
  assert.equal(shutterEnabled('MULTIPLE_PEOPLE', STEADY_MS, false), false);
  assert.equal(shutterEnabled('MULTIPLE_PEOPLE', STEADY_MS, true), false);
});

test('the shutter opens when the detector cannot run at all', () => {
  // No WebGL, a blocked download, an unsupported device. None of those is the
  // instructor's fault, and none may stop them checking in.
  assert.equal(shutterEnabled('UNAVAILABLE', 0, false), true);
});

test('the override permits an imperfect person frame but never an empty frame', () => {
  // A saree hiding the ankles, a wheelchair, a room too small to step back in.
  // Across six hundred daily check-ins even a small miss rate is people who
  // cannot record attendance at all.
  assert.equal(shutterEnabled('PARTIAL', 0, true), true);
  assert.equal(shutterEnabled('NO_PERSON', 0, true), false, 'an empty frame is never attendance evidence');
  // And it is offered soon enough to be a way out, not a punishment.
  assert.ok(OVERRIDE_AFTER_MS <= 20_000, 'nobody should be stuck for longer than this');
});
