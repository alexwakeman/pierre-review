import { describe, expect, it } from 'vitest';
import { parsePmset } from './power.js';
import { cpuShareFrom, threadsFrom, throttleDelayMs } from './throttle.js';

describe('throttle', () => {
  it('rests in proportion to the work, holding the average to the share', () => {
    expect(throttleDelayMs(1000, 0.5)).toBe(1000);
    expect(throttleDelayMs(1000, 0.25)).toBe(3000);
    expect(throttleDelayMs(1000, 1)).toBe(0);
    expect(throttleDelayMs(0, 0.5)).toBe(0);
  });

  it('reads the share and the threads from the env, with safe defaults and bounds', () => {
    expect(cpuShareFrom(undefined)).toBe(0.5);
    expect(cpuShareFrom('')).toBe(0.5);
    expect(cpuShareFrom('abc')).toBe(0.5);
    expect(cpuShareFrom('0')).toBe(0.5);
    expect(cpuShareFrom('0.01')).toBe(0.05);
    expect(cpuShareFrom('3')).toBe(1);
    expect(cpuShareFrom('0.3')).toBe(0.3);
    expect(threadsFrom(undefined)).toBe(1);
    expect(threadsFrom('2')).toBe(2);
    expect(threadsFrom('64')).toBe(4);
    expect(threadsFrom('0')).toBe(1);
  });
});

describe('power source', () => {
  it("reads pmset's answer, and anything else as not known", () => {
    expect(parsePmset("Now drawing from 'Battery Power'\n -InternalBattery-0 (id=1)\t83%; discharging")).toBe(true);
    expect(parsePmset("Now drawing from 'AC Power'\n -InternalBattery-0\t100%; charged")).toBe(false);
    expect(parsePmset("Now drawing from 'AC Power'\n")).toBe(false);
    expect(parsePmset('')).toBeNull();
  });
});
