// ============================================================
// Apps Script Web App cho tool TeamHatDe-Capcut-Auto
// Ghi mỗi profile 1 dòng vào Sheet tổng hoặc file Sheet riêng của nhân viên.
//
// Layout cột (theo sheet của bạn):
//   A  = Nhân viên
//   B  = Date       (thời gian)
//   C  = FullAcess  (mail full: email|password|refresh_token|client_id)
//   H  = CheckOut   (link thanh toán)
//   I  = Còn lại    (đếm ngược 15p kể từ B -> công thức tự tính, tool ghi)
//   M  = lý do lỗi  (chỉ ghi khi profile đó lỗi)
//   L  = DONE?      -> tool KHÔNG đụng, nhân viên tự tick
//
// Ô DÀNH RIÊNG — đừng dùng cho dữ liệu (nên ẩn cột Y và Z):
//   Y  = entryId của dòng, dùng để chống ghi trùng khi retry
//   Z1 = con trỏ "dòng kế tiếp" -> ghi O(1), không quét cả cột
//   Z2 = ô nháp (dò locale của công thức, kiểm tra quyền ghi)
// ============================================================

function doGet() {
  // App kiểm tra version này trước khi chạy để tránh script cũ ghi nhầm dòng
  // dành cho nhân viên vào Sheet tổng.
  return ContentService.createTextOutput('teamhatde-sheet-v3');
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

    var START = 3; // dữ liệu bắt đầu dòng 3 (dòng 1-2 là tiêu đề)

    // Chống ghi trùng: Apps Script ghi xong nhưng response rơi trên đường về thì
    // app coi là lỗi và cho retry — không có bước này là ra 2 dòng giống hệt nhau.
    // Tìm trên cả cột Y (native, nhanh kể cả sheet vài chục nghìn dòng) chứ không
    // quét N dòng cuối: retry là thao tác tay nên có thể xảy ra rất lâu sau đó.
    if (d.entryId) {
      var existing = sheet.getRange('Y:Y')
        .createTextFinder(String(d.entryId))
        .matchEntireCell(true)
        .findNext();
      if (existing) return ContentService.createTextOutput('ok');
    }

    // Con trỏ "dòng kế tiếp" lưu ở ô Z1 — đọc/ghi O(1), KHÔNG quét cả cột.
    var ptrCell = sheet.getRange('Z1');
    var row = Number(ptrCell.getValue()) || START;
    if (row < START) row = START;

    // Lưới an toàn: nếu con trỏ lệch (ai đó xóa/chèn dòng thủ công), nhích tới
    // ô C trống thật. Bình thường vòng này chạy 0 lần nên vẫn O(1).
    while (sheet.getRange(row, 3).getValue() !== '') {
      row++;
    }

    if (d.employeeName) sheet.getRange(row, 1).setValue(d.employeeName); // A = Nhân viên
    sheet.getRange(row, 2).setValue(new Date());             // B = Date
    sheet.getRange(row, 3).setValue(d.mailLine || d.email || ''); // C = FullAcess/email
    sheet.getRange(row, 8).setValue(d.checkoutUrl || '');    // H = CheckOut
    sheet.getRange(row, 13).setValue(d.errorMessage || '');  // M = lý do lỗi
    if (d.entryId) sheet.getRange(row, 25).setValue(String(d.entryId)); // Y = entryId

    // I = đếm ngược 15p kể từ B. Hết giờ -> "HET HAN". Chỉ ghi khi có link.
    // QUAN TRỌNG: dấu ngăn tham số của công thức phụ thuộc LOCALE của sheet —
    // locale dùng phẩy làm thập phân (vi_VN, de_DE…) thì ngăn tham số bằng ';',
    // còn lại dùng ','. setFormula KHÔNG tự đổi, feed sai dấu là #ERROR!. Nên dò
    // dấu đúng rồi mới dựng công thức (chỉ có dấu ngăn tham số là phẩy, "HET HAN"
    // và "mm:ss" không chứa phẩy nên replace toàn bộ ',' là an toàn).
    if (d.checkoutUrl) {
      var sep = argSeparator(sheet);
      var formula = ('=IF(NOW()>=B' + row + '+15/1440,"HET HAN",TEXT(B' + row + '+15/1440-NOW(),"mm:ss"))')
        .replace(/,/g, sep);
      sheet.getRange(row, 9).setFormula(formula);
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
  var START = 3;
  try {
    var spreadsheet = d.targetSpreadsheetId
      ? SpreadsheetApp.openById(String(d.targetSpreadsheetId))
      : SpreadsheetApp.getActiveSpreadsheet();
    var sheet = spreadsheet.getSheets()[0];

    var probe = sheet.getRange('Z2');
    probe.setValue('probe');
    SpreadsheetApp.flush();
    probe.clearContent();

    var row = Number(sheet.getRange('Z1').getValue()) || START;
    if (row < START) row = START;

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

// Dò dấu ngăn tham số công thức theo LOCALE của sheet bằng cách GHI THỬ =SUM(1,1)
// rồi đọc KẾT QUẢ SỐ — hai locale cho hai số khác nhau rõ ràng, KHÔNG bao giờ lỗi,
// nên không phụ thuộc chuỗi "#ERROR!" (tuỳ parser) hay định dạng số của ô.
//   - locale ',' : dấu ',' là ngăn tham số -> SUM(1;1) = 2  -> dùng ','
//   - locale ';' : dấu ',' là thập phân    -> "1,1" = 1.1   -> SUM(1.1) = 1.1 -> dùng ';'
// getValue() trả số thô bất kể number format; flush() ép tính trước khi đọc.
function argSeparator(sheet) {
  var probe = sheet.getRange('Z2'); // ô nháp (Z1 đang giữ con trỏ dòng)
  probe.setFormula('=SUM(1,1)');
  SpreadsheetApp.flush();
  var v = probe.getValue();
  probe.clearContent();
  return v === 2 ? ',' : ';';
}
