import { rename, rm, writeFile } from 'node:fs/promises';

/** Hàng đợi ghi theo từng đường dẫn file. */
const queues = new Map<string, Promise<void>>();
let sequence = 0;

/**
 * Ghi JSON theo kiểu atomic: ghi ra file tạm rồi `rename` đè lên file thật.
 *
 * `writeFile` thẳng vào file đích sẽ TRUNCATE nó trước khi ghi nội dung mới —
 * mất điện hoặc app bị kill đúng khoảnh khắc đó là còn lại một file rỗng hoặc
 * đứt giữa chừng, tức mất sạch profiles/proxies/mails. `rename` trong cùng một
 * filesystem là thao tác atomic ở tầng OS: hoặc thấy bản cũ nguyên vẹn, hoặc
 * thấy bản mới nguyên vẹn, không bao giờ thấy bản dở dang.
 *
 * Hai chỗ dễ sai đã xử lý:
 *  - Tên file tạm mang PID VÀ số thứ tự tăng dần. Hai lời gọi đồng thời trong
 *    cùng tiến trình mà dùng chung một tên tạm thì nội dung của chúng trộn vào
 *    nhau và `rename` ra một file JSON hỏng.
 *  - Các lời gọi trên CÙNG một file được xếp hàng, nên bản ghi cuối cùng theo
 *    thứ tự gọi cũng là bản nằm lại trên đĩa. Không có hàng đợi thì hai request
 *    song song có thể `rename` ngược thứ tự và ghi đè trạng thái mới bằng cũ.
 *
 * `rename` lỗi (vài filesystem mạng không hỗ trợ đè) thì lùi về ghi thẳng —
 * vẫn hơn là không ghi được gì.
 */
export function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  const data = JSON.stringify(value, null, 2);
  const previous = queues.get(file) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(() => writeOnce(file, data));
  queues.set(file, next.catch(() => {}));
  return next;
}

async function writeOnce(file: string, data: string): Promise<void> {
  sequence += 1;
  const temp = `${file}.${process.pid}.${sequence}.tmp`;
  await writeFile(temp, data, 'utf8');
  try {
    await rename(temp, file);
  } catch {
    await rm(temp, { force: true });
    await writeFile(file, data, 'utf8');
  }
}
