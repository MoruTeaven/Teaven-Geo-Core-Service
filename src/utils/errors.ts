/**
 * API 错误契约模块（对外错误响应的唯一出口）
 *
 * 设计原则：
 * - 对外只暴露稳定错误码（code）与调用方视角文案，D1/SQL/堆栈等内部细节绝不进入响应体
 * - 已知业务错误用 ApiError 表达（自带 code 与 HTTP 状态）
 * - 未知异常一律收敛为 500 INTERNAL_ERROR，原始错误仅写 console（Workers Logs）
 *
 * 状态码选型（RFC 9110）：
 * - 400 INVALID_PARAM      仅客户端参数错误（缺参/格式错）
 * - 404 NOT_FOUND          资源不存在（无此地 / 无此 ID）
 * - 422 AMBIGUOUS_MATCH    请求合法但语义上无法唯一解析（歧义地名）
 * - 429 RATE_LIMITED       触发速率限制
 * - 500 INTERNAL_ERROR     未知内部错误（含 DB 故障），客户端不应重试同请求
 * - 503 SERVICE_UNAVAILABLE 依赖不可用（health 检查失败），客户端可稍后重试
 */

import type { ApiErrorCode } from '../types';

export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly status: number;

  constructor(code: ApiErrorCode, message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
  }
}

export function invalidParam(message: string): ApiError {
  return new ApiError('INVALID_PARAM', message, 400);
}

export function notFound(message: string): ApiError {
  return new ApiError('NOT_FOUND', message, 404);
}

export function ambiguousMatch(message: string): ApiError {
  return new ApiError('AMBIGUOUS_MATCH', message, 422);
}

export function rateLimited(message: string): ApiError {
  return new ApiError('RATE_LIMITED', message, 429);
}

export function serviceUnavailable(message: string): ApiError {
  return new ApiError('SERVICE_UNAVAILABLE', message, 503);
}

export interface ApiErrorBody {
  error: boolean;
  code: ApiErrorCode;
  message: string;
}

/**
 * 把任意异常转为对外安全响应体：
 * - ApiError → 按契约透出 code 与调用方视角 message
 * - 其它异常 → 稳定 500 文案，内部细节只写日志（绝不进响应体）
 *
 * @param e          捕获到的异常
 * @param logContext 日志上下文标识（如 'geo/search'）
 * @param details    附加日志上下文（仅进日志，不进响应体）
 */
export function toApiError(
  e: unknown,
  logContext: string,
  details?: Record<string, unknown>,
): { body: ApiErrorBody; status: number } {
  if (e instanceof ApiError) {
    return { body: { error: true, code: e.code, message: e.message }, status: e.status };
  }
  const detail = e instanceof Error ? (e.stack || e.message) : String(e);
  console.error(`[${logContext}] internal error:`, detail, details ? JSON.stringify(details) : '');
  return {
    body: { error: true, code: 'INTERNAL_ERROR', message: 'Internal server error' },
    status: 500,
  };
}
