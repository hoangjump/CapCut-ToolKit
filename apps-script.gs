// ============================================================
// Apps Script Web App cho tool TeamHatDe-Capcut-Auto
// Ghi mỗi profile 1 dòng vào Sheet tổng hoặc file Sheet riêng của nhân viên.
//
// MUỐN ĐỔI LAYOUT SHEET? Sửa BẢNG ÁNH XẠ CỘT ngay bên dưới, không đụng gì khác.
// ============================================================

// Số thứ tự cột: A=1, B=2, … Y=25, Z=26. Đặt 0 = không ghi trường đó.
// `mail` cũng là cột dùng để dò dòng trống, nên bắt buộc phải có.
var LAYOUT = {
  // Sheet TỔNG — giữ đúng layout đang dùng (A=STT, M=DONE?, N=ERROR? là của bạn,
  // script KHÔNG đụng vào). Chỉ thêm Q và R.
  total: {
    startRow: 3,      // dòng 1-2 là tiêu đề
    employeeName: 17, // Q = Nhân viên   <- cột THÊM MỚI
    date: 2,          // B = Date
    mail: 3,          // C = FullAcess (mail full)
    checkout: 8,      // H = CheckOut
    countdown: 9,     // I = Time
    error: 18,        // R = Lý do lỗi  <- cột THÊM MỚI
  },
  // Sheet RIÊNG của nhân viên — hẹp, chỉ những gì nhân viên cần thấy.
  // Cột G (DONE?) để nhân viên tự tick, script không bao giờ ghi vào đó.
  employee: {
    startRow: 3,
    employeeName: 1,  // A = Nhân viên
    date: 2,          // B = Date
    mail: 3,          // C = Email (không có password/refresh/client)
    checkout: 4,      // D = CheckOut
    countdown: 5,     // E = Còn lại
    error: 6,         // F = Lý do lỗi
  },
};

// Ô dành riêng cho script, dùng chung cho cả hai loại sheet. Nên ẩn cột Y và Z.
var COL_ENTRY_ID = 25;        // Y = dấu chống ghi trùng
var CELL_ROW_POINTER = 'Z1';  // con trỏ "dòng kế tiếp" -> ghi O(1)
var CELL_SCRATCH = 'Z2';      // ô nháp (dò locale, kiểm tra quyền ghi)

function doGet() {
  // App kiểm tra version này trước khi chạy để tránh script cũ ghi nhầm cột.
  return ContentService.createTextOutput('teamhatde-sheet-v4');
}

function doPost(e) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000); // 10 luồng ghi song song -> xếp hàng để không đè dòng nhau
  try {
    var d = JSON.parse(e.postData.contents);

    // Nút "Ghi thử" trong app: chỉ xác nhận cấu hình, KHÔNG thêm dòng dữ liệu.
    // Chạy TRƯỚC khi mở file, vì chính openById là chỗ hay ném lỗi thiếu quyền —
    // để lỗi thoát ra ngoài thì Apps Script trả HTTP 500 kèm HTML, app chỉ đọc
    // được "HTTP 500" thay vì lý do thật. probeResult tự bắt và trả lỗi dạng JSON.
    if (d.probe) return probeResult(d);

    // Không truyền targetSpreadsheetId -> ghi Sheet tổng đang gắn Apps Script.
    // Có targetSpreadsheetId -> ghi file riêng của nhân viên. Web App phải chạy
    // dưới tài khoản chủ sở hữu có quyền mở các file đó.
    var spreadsheet = d.targetSpreadsheetId
      ? SpreadsheetApp.openById(String(d.targetSpreadsheetId))
      : SpreadsheetApp.getActiveSpreadsheet();
    var sheet = spreadsheet.getSheets()[0];
    var L = d.targetSpreadsheetId ? LAYOUT.employee : LAYOUT.total;

    // Chống ghi trùng: Apps Script ghi xong nhưng response rơi trên đường về thì
    // app coi là lỗi và cho retry — không có bước này là ra 2 dòng giống hệt nhau.
    // Tìm trên cả cột Y (native, nhanh kể cả sheet vài chục nghìn dòng) chứ không
    // quét N dòng cuối: retry là thao tác tay nên có thể xảy ra rất lâu sau đó.
    if (d.entryId) {
      var existing = sheet.getRange(colLetter(COL_ENTRY_ID) + ':' + colLetter(COL_ENTRY_ID))
        .createTextFinder(String(d.entryId))
        .matchEntireCell(true)
        .findNext();
      if (existing) return ContentService.createTextOutput('ok');
    }

    var ptrCell = sheet.getRange(CELL_ROW_POINTER);
    var row = Number(ptrCell.getValue()) || L.startRow;
    if (row < L.startRow) row = L.startRow;

    // Lưới an toàn: nếu con trỏ lệch (ai đó xóa/chèn dòng thủ công), nhích tới
    // ô trống thật ở cột mail. Bình thường vòng này chạy 0 lần nên vẫn O(1).
    while (sheet.getRange(row, L.mail).getValue() !== '') {
      row++;
    }

    if (L.employeeName && d.employeeName) sheet.getRange(row, L.employeeName).setValue(d.employeeName);
    if (L.date) sheet.getRange(row, L.date).setValue(new Date());
    sheet.getRange(row, L.mail).setValue(d.mailLine || d.email || '');
    if (L.checkout) sheet.getRange(row, L.checkout).setValue(d.checkoutUrl || '');
    if (L.error) sheet.getRange(row, L.error).setValue(d.errorMessage || '');
    if (d.entryId) sheet.getRange(row, COL_ENTRY_ID).setValue(String(d.entryId));

    // Đếm ngược 15p kể từ ô Date. Hết giờ -> "HET HAN". Chỉ ghi khi có link.
    // QUAN TRỌNG: dấu ngăn tham số của công thức phụ thuộc LOCALE của sheet —
    // locale dùng phẩy làm thập phân (vi_VN, de_DE…) thì ngăn tham số bằng ';',
    // còn lại dùng ','. setFormula KHÔNG tự đổi, feed sai dấu là #ERROR!. Nên dò
    // dấu đúng rồi mới dựng công thức (chỉ có dấu ngăn tham số là phẩy, "HET HAN"
    // và "mm:ss" không chứa phẩy nên replace toàn bộ ',' là an toàn).
    if (d.checkoutUrl && L.countdown && L.date) {
      var dateRef = colLetter(L.date) + row;
      var sep = argSeparator(sheet);
      var formula = ('=IF(NOW()>=' + dateRef + '+15/1440,"HET HAN",TEXT(' + dateRef + '+15/1440-NOW(),"mm:ss"))')
        .replace(/,/g, sep);
      sheet.getRange(row, L.countdown).setFormula(formula);
    }

    ptrCell.setValue(row + 1); // dời con trỏ xuống

    return ContentService.createTextOutput('ok');
  } finally {
    lock.releaseLock();
  }
}

// Xác nhận file này dùng được TRƯỚC khi chạy đợt phân phối, không để lại rác.
// openById() vẫn mở được file chỉ-xem, nên phải GHI THỬ thật (Z2) mới kết luận
// được là có quyền Edit — chạy trong lock nên không đụng argSeparator().
// LUÔN trả HTTP 200 kèm JSON, kể cả khi hỏng: có vậy app mới đọc được lý do thật
// thay vì trang HTML lỗi mặc định của Apps Script.
function probeResult(d) {
  var L = d.targetSpreadsheetId ? LAYOUT.employee : LAYOUT.total;
  try {
    var spreadsheet = d.targetSpreadsheetId
      ? SpreadsheetApp.openById(String(d.targetSpreadsheetId))
      : SpreadsheetApp.getActiveSpreadsheet();
    var sheet = spreadsheet.getSheets()[0];

    var probe = sheet.getRange(CELL_SCRATCH);
    probe.setValue('probe');
    SpreadsheetApp.flush();
    probe.clearContent();

    var row = Number(sheet.getRange(CELL_ROW_POINTER).getValue()) || L.startRow;
    if (row < L.startRow) row = L.startRow;

    return probeJson({
      ok: true,
      spreadsheetName: spreadsheet.getName(),
      sheetName: sheet.getName(),
      nextRow: row,
    });
  } catch (err) {
    return probeJson({ ok: false, error: String(err && err.message ? err.message : err) });
  }
}

function probeJson(payload) {
  return ContentService
    .createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}

// 1 -> "A", 25 -> "Y", 27 -> "AA". Để công thức và dải tìm kiếm bám theo LAYOUT
// thay vì hardcode chữ cái.
function colLetter(index) {
  var letter = '';
  var n = index;
  while (n > 0) {
    var rem = (n - 1) % 26;
    letter = String.fromCharCode(65 + rem) + letter;
    n = Math.floor((n - 1) / 26);
  }
  return letter;
}

// Dò dấu ngăn tham số công thức theo LOCALE của sheet bằng cách GHI THỬ =SUM(1,1)
// rồi đọc KẾT QUẢ SỐ — hai locale cho hai số khác nhau rõ ràng, KHÔNG bao giờ lỗi,
// nên không phụ thuộc chuỗi "#ERROR!" (tuỳ parser) hay định dạng số của ô.
//   - locale ',' : dấu ',' là ngăn tham số -> SUM(1;1) = 2  -> dùng ','
//   - locale ';' : dấu ',' là thập phân    -> "1,1" = 1.1   -> SUM(1.1) = 1.1 -> dùng ';'
// getValue() trả số thô bất kể number format; flush() ép tính trước khi đọc.
function argSeparator(sheet) {
  var probe = sheet.getRange(CELL_SCRATCH); // ô nháp (Z1 đang giữ con trỏ dòng)
  probe.setFormula('=SUM(1,1)');
  SpreadsheetApp.flush();
  var v = probe.getValue();
  probe.clearContent();
  return v === 2 ? ',' : ';';
}
