import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("nucleation", () => ({ default: vi.fn(), SchematicWrapper: class {} }));

import { PerformanceMonitor, performanceMonitor } from "../PerformanceMonitor";
import { SchematicObject } from "../../managers/SchematicObject";

// a fresh monitor per test, not the shared instance
const monitor = () => new (PerformanceMonitor as unknown as new () => PerformanceMonitor)();

describe("PerformanceMonitor", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => {
		vi.clearAllTimers();
		vi.useRealTimers();
	});

	it("keeps only the last MAX_SESSIONS sessions", () => {
		const m = monitor();
		const ids: string[] = [];
		for (let i = 0; i < PerformanceMonitor.MAX_SESSIONS + 5; i++) {
			ids.push(m.startSession(`s${i}`, "batched"));
			m.endSession(ids[i]);
		}
		expect(m.getAllSessions()).toHaveLength(PerformanceMonitor.MAX_SESSIONS);
		expect(m.getSession(ids[4])).toBeNull();
		expect(m.getSession(ids[5])).not.toBeNull();
		expect(m.getSession(ids[ids.length - 1])).not.toBeNull();
	});

	it("drops ended sessions before an unfinished one, and never the current one", () => {
		const m = monitor();
		const unfinished = m.startSession("unfinished", "batched");
		for (let i = 0; i < PerformanceMonitor.MAX_SESSIONS; i++) {
			m.endSession(m.startSession(`s${i}`, "batched"));
		}
		const current = m.startSession("current", "batched");
		expect(m.getAllSessions()).toHaveLength(PerformanceMonitor.MAX_SESSIONS);
		expect(m.getSession(unfinished)).not.toBeNull();
		expect(m.getSession(current)).toBe(m.getCurrentSession());
	});

	it("stops its timers when the session ends", () => {
		const m = monitor();
		const id = m.startSession("a", "batched");
		expect(vi.getTimerCount()).toBeGreaterThan(0); // memory snapshots, fps, frame loop
		vi.advanceTimersByTime(1000);
		m.endSession(id);
		expect(vi.getTimerCount()).toBe(0);
		vi.advanceTimersByTime(1000);
		expect(m.getSession(id)!.memorySnapshots.length).toBeGreaterThan(2);
	});

	it("an older session ending leaves the current one's monitoring running", () => {
		const m = monitor();
		const older = m.startSession("a", "batched");
		const current = m.startSession("b", "batched");
		m.endSession(older);
		expect(m.getCurrentSession()?.sessionId).toBe(current);
		const before = m.getSession(current)!.memorySnapshots.length;
		vi.advanceTimersByTime(500);
		expect(m.getSession(current)!.memorySnapshots.length).toBeGreaterThan(before);
		m.endSession(current);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("background monitoring keeps the frame loop, not the memory snapshots, after a session", () => {
		const m = monitor();
		m.startBackgroundMonitoring();
		m.endSession(m.startSession("a", "batched"));
		vi.advanceTimersByTime(2000);
		expect(m.getCurrentFPS()).toBeGreaterThan(0);
		m.stopBackgroundMonitoring();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("clearing the sessions stops the monitoring", () => {
		const m = monitor();
		m.startSession("a", "batched");
		m.clearSessions();
		expect(vi.getTimerCount()).toBe(0);
	});
});

describe("a build that fails", () => {
	afterEach(() => performanceMonitor.clearAllSessions());

	it("ends its session, so its monitoring stops", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		const so = Object.create(SchematicObject.prototype) as any;
		Object.assign(so, { id: "s", name: "s", schematicRenderer: { options: {} } });
		so.buildSchematicMeshesBatched = vi.fn().mockRejectedValue(new Error("mesher failed"));

		await expect(so.buildSchematicMeshes(so, undefined, "batched")).rejects.toThrow(
			"mesher failed"
		);
		expect(performanceMonitor.getCurrentSession()).toBeNull();
		expect(performanceMonitor.getAllSessions()[0].endTime).toBeDefined();
		vi.restoreAllMocks();
	});
});
