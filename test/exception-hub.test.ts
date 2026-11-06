import { describe, expect, it, vi } from 'vitest';
import type { IntakeEnv } from 'framework_sdk_worker/intake';
import {
    analyzeExceptionEvent,
    classifyPlatformTransient,
    EXCEPTION_LOG_MSG,
    PLATFORM_TRANSIENT_LOG_MSG,
    recordExceptionHub,
    UNCAUGHT_REASON,
} from '../src/exception-hub.js';

const CONTAINER_UNAVAILABLE =
    'There is no container instance that can be provided to this Durable Object, try again later';

describe('analyzeExceptionEvent', () => {
    it('skips tal1 self and empty script', () => {
        expect(analyzeExceptionEvent({ scriptName: 'tal1', outcome: 'exception' })).toEqual({
            log: null,
            intake: null,
        });
        expect(analyzeExceptionEvent({ scriptName: '', outcome: 'exception' })).toEqual({
            log: null,
            intake: null,
        });
    });

    it('logs + intake for uncaught exceptions with remapped stack', () => {
        const { log, intake } = analyzeExceptionEvent({
            scriptName: 'notify-worker',
            outcome: 'exception',
            event: { request: { method: 'GET', url: 'https://api.mailworld.uk/v1/send' } },
            exceptions: [
                {
                    name: 'TypeError',
                    message: 'x is not a function',
                    stack: 'TypeError: x is not a function\n    at parse (src/down.ts:30:8)',
                },
            ],
        });
        expect(log).toMatchObject({
            msg: EXCEPTION_LOG_MSG,
            scriptName: 'notify-worker',
            outcome: 'exception',
            path: '/v1/send',
        });
        expect(log?.platformReason).toBeUndefined();
        expect(log?.exceptions?.[0]?.stack).toContain('src/down.ts:30:8');
        expect(intake).not.toBeNull();
        expect(intake?.kind).toBe('ops.error');
        expect(intake?.source).toEqual({ producer: 'tal1', worker: 'notify-worker' });
        expect(intake?.title).toContain(UNCAUGHT_REASON);
        expect(JSON.stringify(intake?.payload)).toContain('src/down.ts:30:8');
    });

    it('logs errorInfo only without intake', () => {
        const { log, intake } = analyzeExceptionEvent({
            scriptName: 'email-rule-worker',
            outcome: 'ok',
            logs: [
                {
                    level: 'error',
                    message: ['caught', 'RangeError: out'],
                    errorInfo: [
                        null,
                        {
                            name: 'RangeError',
                            message: 'out',
                            stack: 'RangeError: out\n    at worker.js:1:10',
                        },
                    ],
                },
            ],
        });
        expect(log?.errorInfo?.[0]?.name).toBe('RangeError');
        expect(log?.exceptions).toBeUndefined();
        expect(intake).toBeNull();
    });

    it('intakes when outcome=exception even if exceptions array empty', () => {
        const { log, intake } = analyzeExceptionEvent({
            scriptName: 'sch1',
            outcome: 'exception',
            exceptions: [],
            logs: [],
        });
        // no exceptions and no errorInfo → nothing
        expect(log).toBeNull();
        expect(intake).toBeNull();

        const again = analyzeExceptionEvent({
            scriptName: 'sch1',
            outcome: 'exception',
            exceptions: [{ name: 'Error', message: 'boom' }],
        });
        expect(again.intake?.summary).toContain('boom');
    });

    it('classifies CF container-unavailable as platform transient: warn log, no intake', () => {
        const canceled = analyzeExceptionEvent({
            scriptName: 'fund-info-worker',
            outcome: 'canceled',
            event: { request: { method: 'GET', url: 'https://api.example.com/api/v1/funds' } },
            scriptVersion: { id: '2c440105-e6f6-4556-bb50-0d3913ede2d1' },
            exceptions: [{ name: 'Error', message: CONTAINER_UNAVAILABLE, timestamp: 1793881371053 }],
        });
        expect(canceled.log).toMatchObject({
            msg: PLATFORM_TRANSIENT_LOG_MSG,
            scriptName: 'fund-info-worker',
            outcome: 'canceled',
            path: '/api/v1',
            platformReason: 'container_unavailable',
        });
        expect(canceled.intake).toBeNull();

        const okOutcome = analyzeExceptionEvent({
            scriptName: 'fund-info-worker',
            outcome: 'ok',
            exceptions: [{ name: 'Error', message: CONTAINER_UNAVAILABLE }],
        });
        expect(okOutcome.log?.msg).toBe(PLATFORM_TRANSIENT_LOG_MSG);
        expect(okOutcome.log?.platformReason).toBe('container_unavailable');
        expect(okOutcome.intake).toBeNull();
    });

    it('does not hide a real crash mixed with a platform transient', () => {
        const { log, intake } = analyzeExceptionEvent({
            scriptName: 'fund-info-worker',
            outcome: 'exception',
            exceptions: [
                { name: 'Error', message: CONTAINER_UNAVAILABLE },
                { name: 'TypeError', message: 'x is not a function' },
            ],
        });
        expect(log?.msg).toBe(EXCEPTION_LOG_MSG);
        expect(log?.platformReason).toBeUndefined();
        expect(intake).not.toBeNull();
        expect(intake?.title).toContain(UNCAUGHT_REASON);
    });
});

describe('classifyPlatformTransient', () => {
    it('matches known CF retryable platform messages', () => {
        expect(
            classifyPlatformTransient([{ message: CONTAINER_UNAVAILABLE }]),
        ).toBe('container_unavailable');
        expect(
            classifyPlatformTransient([
                {
                    message:
                        'Maximum number of running container instances exceeded. Try again later, or try configuring a higher value for max_instances',
                },
            ]),
        ).toBe('container_max_instances');
        expect(
            classifyPlatformTransient([
                { message: 'Durable Object is overloaded. Too many requests queued.' },
            ]),
        ).toBe('durable_object_overloaded');
        expect(
            classifyPlatformTransient([
                {
                    message:
                        'Your account is generating too much load on Durable Objects. Please back off and try again later.',
                },
            ]),
        ).toBe('durable_object_account_load');
        expect(classifyPlatformTransient([{ message: 'x is not a function' }])).toBeNull();
        expect(classifyPlatformTransient([])).toBeNull();
    });
});

describe('recordExceptionHub', () => {
    it('console.error JSON and submitIntake for uncaught', () => {
        const error = vi.spyOn(console, 'error').mockImplementation(() => {});
        const waitUntil = vi.fn();
        const env = {
            SVC_SCH1: { fetch: vi.fn(async () => new Response('{}', { status: 200 })) },
            SCH_INTAKE_TOKEN: 'test-token',
        } as unknown as IntakeEnv;
        const result = recordExceptionHub(
            [
                {
                    scriptName: 'llm-gateway-worker',
                    outcome: 'exception',
                    exceptions: [{ name: 'Error', message: 'fail', stack: 'at src/x.ts:1:1' }],
                },
            ],
            env,
            { waitUntil },
        );
        expect(result).toEqual({ logged: 1, intakeSubmitted: 1 });
        expect(error).toHaveBeenCalledOnce();
        expect(JSON.parse(String(error.mock.calls[0]?.[0]))).toMatchObject({
            msg: EXCEPTION_LOG_MSG,
            scriptName: 'llm-gateway-worker',
        });
        expect(waitUntil).toHaveBeenCalled();
        error.mockRestore();
    });

    it('console.warn JSON and skips intake for container-unavailable', () => {
        const error = vi.spyOn(console, 'error').mockImplementation(() => {});
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const waitUntil = vi.fn();
        const env = {
            SVC_SCH1: { fetch: vi.fn(async () => new Response('{}', { status: 200 })) },
            SCH_INTAKE_TOKEN: 'test-token',
        } as unknown as IntakeEnv;
        const result = recordExceptionHub(
            [
                {
                    scriptName: 'fund-info-worker',
                    outcome: 'canceled',
                    exceptions: [{ name: 'Error', message: CONTAINER_UNAVAILABLE }],
                },
            ],
            env,
            { waitUntil },
        );
        expect(result).toEqual({ logged: 1, intakeSubmitted: 0 });
        expect(error).not.toHaveBeenCalled();
        expect(warn).toHaveBeenCalledOnce();
        expect(JSON.parse(String(warn.mock.calls[0]?.[0]))).toMatchObject({
            msg: PLATFORM_TRANSIENT_LOG_MSG,
            platformReason: 'container_unavailable',
            scriptName: 'fund-info-worker',
        });
        expect(waitUntil).not.toHaveBeenCalled();
        error.mockRestore();
        warn.mockRestore();
    });
});
