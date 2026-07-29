import type { NextFunction, Request, RequestHandler, Response } from 'express';

/**
 * Bọc một handler async. Không có lớp này thì mỗi route phải tự viết
 * `try { … } catch (err) { res.status(400).json({ error: … }) }` — hơn 50 lần
 * lặp lại y hệt, và chỉ cần quên một chỗ là promise reject rơi ra ngoài Express
 * (Express 4 KHÔNG bắt được reject của handler async) rồi treo request cho tới
 * lúc client bỏ cuộc.
 *
 * Ném `HttpError` để chọn status; ném Error thường thì mặc định 400 vì gần như
 * mọi lỗi ở đây là dữ liệu người dùng gửi lên không hợp lệ.
 */
export function asyncHandler(handler: (req: Request, res: Response) => Promise<unknown>): RequestHandler {
  return (req, res, next) => {
    handler(req, res).catch(next);
  };
}

export class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'HttpError';
  }
}

export function notFound(message: string): HttpError {
  return new HttpError(404, message);
}

/** Lỗi của Express và http-errors mang sẵn status ở `status`/`statusCode` —
 *  ví dụ body vượt limit là 413 kèm message "request entity too large". Bỏ qua
 *  chúng là mọi lỗi hạ tầng đều hiện thành 400, che mất nguyên nhân thật. */
function statusOf(err: unknown): number {
  if (err instanceof HttpError) return err.status;
  const raw = err as { status?: unknown; statusCode?: unknown };
  for (const value of [raw?.status, raw?.statusCode]) {
    if (typeof value === 'number' && value >= 400 && value <= 599) return value;
  }
  return 400;
}

/** Đổi vài lỗi hạ tầng sang câu người dùng đọc hiểu và biết phải làm gì. */
function friendly(status: number, message: string): string {
  if (status === 413) {
    return 'Danh sách quá lớn cho một lần gửi. Hãy chia file thành nhiều phần nhỏ hơn rồi import từng phần.';
  }
  if (message === 'invalid json' || /^Unexpected token .* in JSON/.test(message)) {
    return 'Dữ liệu gửi lên không phải JSON hợp lệ.';
  }
  return message;
}

/** Middleware lỗi cuối chuỗi. Phải đăng ký SAU mọi route. */
export function errorMiddleware(log: { warn: (msg: string) => void }): (
  err: unknown, req: Request, res: Response, next: NextFunction,
) => void {
  return (err, req, res, next) => {
    if (res.headersSent) return next(err);
    const status = statusOf(err);
    const message = err instanceof Error ? err.message : String(err);
    if (status >= 500 || status === 413) log.warn(`${req.method} ${req.path} → ${status}: ${message}`);
    res.status(status).json({ error: friendly(status, message) });
  };
}
