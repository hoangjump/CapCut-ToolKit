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

/** Middleware lỗi cuối chuỗi. Phải đăng ký SAU mọi route. */
export function errorMiddleware(log: { warn: (msg: string) => void }): (
  err: unknown, req: Request, res: Response, next: NextFunction,
) => void {
  return (err, req, res, next) => {
    if (res.headersSent) return next(err);
    const status = err instanceof HttpError ? err.status : 400;
    const message = err instanceof Error ? err.message : String(err);
    if (status >= 500) log.warn(`${req.method} ${req.path} lỗi: ${message}`);
    res.status(status).json({ error: message });
  };
}
