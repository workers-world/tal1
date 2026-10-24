/**
 * Tail TraceItem → 结构化异常日志 + sch1 ops.error Intake（仅未捕获）。
 * AE invocation_slo 仍由 trace-to-point 写入，本模块不碰 stack→AE。
 */
import {
    type IntakeEnv,
    intakePlatformAssembleUncaughtException,
    intakePublishAsync,
} from 'framework_sdk_worker/intake';
import { pathPrefix, TAIL_SCRIPT_NAME, type TraceLike } from './trace-to-point.js';

export const UNCAUGHT_REASON = 'uncaught_exception';

export interface TraceExceptionLike {
    name?: string;
    message?: string;
    stack?: string;
    timestamp?: number;
}

export interface TraceErrorInfoLike {
    name?: string;
    message?: string;
    stack?: string;
}

export interface TraceLogLike {
    level?: string;
    message?: unknown;
    timestamp?: number;
    errorInfo?: Array<TraceErrorInfoLike | null>;
}

export interface TraceExceptionEvent extends TraceLike {
    exceptions?: TraceExceptionLike[] | null;
    logs?: TraceLogLike[] | null;
    scriptVersion?: { id?: string; message?: string; tag?: string } | null;
}

export interface ExceptionLogPayload {
    msg: 'tal1_exception';
    scriptName: string;
    outcome: string;
    path: string;
    scriptVersion?: { id?: string; message?: string; tag?: string };
    exceptions?: TraceExceptionLike[];
    errorInfo?: TraceErrorInfoLike[];
}

export interface ExceptionHubResult {
    log: ExceptionLogPayload | null;
    /** 仅未捕获异常时有值；调用方再 intakePublish */
    intake: ReturnType<typeof intakePlatformAssembleUncaughtException> | null;
}

/** Tail TraceItem 上尝试读取的平台 hop（字段因 workerd 版本而异，fail-open） */
function resolveTailHop(event: TraceExceptionEvent): { requestId?: string; note?: string } {
    const record = event as TraceExceptionEvent & {
        diagnosticsChannelId?: string;
        rayId?: string;
        requestId?: string;
        invocationId?: string;
    };
    const requestId =
        record.invocationId?.trim() ||
        record.requestId?.trim() ||
        record.diagnosticsChannelId?.trim() ||
        record.rayId?.trim() ||
        undefined;
    if (requestId) {
        return { requestId };
    }
    return { note: 'tal1-tail: TraceItem 无 requestId/invocationId（平台字段未暴露）' };
}

function collectErrorInfo(logs: TraceLogLike[] | null | undefined): TraceErrorInfoLike[] {
    if (!logs?.length) {
        return [];
    }
    const out: TraceErrorInfoLike[] = [];
    for (const log of logs) {
        if (!log.errorInfo?.length) {
            continue;
        }
        for (const info of log.errorInfo) {
            if (info == null) {
                continue;
            }
            out.push({
                name: info.name,
                message: info.message,
                stack: info.stack,
            });
        }
    }
    return out;
}

function formatExceptionShort(ex: TraceExceptionLike): string {
    const name = String(ex.name ?? 'Error').trim() || 'Error';
    const message = String(ex.message ?? '').trim();
    return message ? `${name}: ${message}` : name;
}

function joinStacks(exceptions: TraceExceptionLike[]): string {
    const parts: string[] = [];
    for (const ex of exceptions) {
        const stack = String(ex.stack ?? '').trim();
        if (stack) {
            parts.push(stack);
            continue;
        }
        parts.push(formatExceptionShort(ex));
    }
    return parts.join('\n---\n');
}

/** 纯函数：从单条 Tail 事件抽出日志载荷与可选 Intake 事件 */
export function analyzeExceptionEvent(event: TraceExceptionEvent): ExceptionHubResult {
    const scriptName = String(event.scriptName ?? '').trim();
    if (!scriptName || scriptName === TAIL_SCRIPT_NAME) {
        return { log: null, intake: null };
    }

    const exceptions = Array.isArray(event.exceptions)
        ? event.exceptions.filter((e) => e != null)
        : [];
    const errorInfo = collectErrorInfo(event.logs);
    if (exceptions.length === 0 && errorInfo.length === 0) {
        return { log: null, intake: null };
    }

    const outcome = String(event.outcome ?? 'unknown');
    const path = pathPrefix(event.event?.request?.url);
    const log: ExceptionLogPayload = {
        msg: 'tal1_exception',
        scriptName,
        outcome,
        path,
        ...(event.scriptVersion ? { scriptVersion: event.scriptVersion } : {}),
        ...(exceptions.length > 0 ? { exceptions } : {}),
        ...(errorInfo.length > 0 ? { errorInfo } : {}),
    };

    const uncaught = exceptions.length > 0 || outcome === 'exception';
    if (!uncaught) {
        return { log, intake: null };
    }

    const primary = exceptions[0] ?? { name: 'Error', message: outcome };
    const error = formatExceptionShort(primary);
    const stack = exceptions.length > 0 ? joinStacks(exceptions) : error;

    const hop = resolveTailHop(event);
    const intake = intakePlatformAssembleUncaughtException({
        producer: TAIL_SCRIPT_NAME,
        worker: scriptName,
        error,
        hop: {
            ...(hop.requestId ? { requestId: hop.requestId, invocationId: hop.requestId } : {}),
            ...(hop.note ? { note: hop.note } : {}),
            scriptName,
        },
        requestId: hop.requestId,
        context: {
            stack,
            path,
            outcome,
            ...(event.scriptVersion?.id ? { scriptVersionId: event.scriptVersion.id } : {}),
        },
    });

    return { log, intake };
}

/** 写 tal1 Workers Logs +（可选）sch1 Intake；不发邮件 */
export function recordExceptionHub(
    events: readonly TraceExceptionEvent[],
    env: IntakeEnv,
    ctx?: Pick<ExecutionContext, 'waitUntil'>,
): { logged: number; intakeSubmitted: number } {
    let logged = 0;
    let intakeSubmitted = 0;
    for (const event of events) {
        const { log, intake } = analyzeExceptionEvent(event);
        if (log) {
            console.error(JSON.stringify(log));
            logged += 1;
        }
        if (intake) {
            intakePublishAsync(env, intake, { ctx, channel: 'platform' });
            intakeSubmitted += 1;
        }
    }
    return { logged, intakeSubmitted };
}
