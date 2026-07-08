// ============================================================
// Apps Script Web App cho tool TeamHatDe-Auto
// Ghi mỗi profile 1 dòng vào Google Sheet.
//
// Layout cột (theo sheet của bạn):
//   B  = Date       (thời gian)
//   C  = FullAcess  (mail full: email|password|refresh_token|client_id)
//   H  = CheckOut   (link thanh toán)
//   I  = Còn lại    (đếm ngược 15p kể từ B -> công thức tự tính, tool ghi)
//   M  = lý do lỗi  (chỉ ghi khi profile đó lỗi)
//   L  = DONE?      -> tool KHÔNG đụng, nhân viên tự tick
//
// Dùng con trỏ ở ô Z1 để biết dòng kế tiếp -> ghi O(1), không quét cả cột,
// nên 1000+ dòng vẫn nhanh như dòng đầu.
// ============================================================

function doPost(e) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000); // 10 luồng ghi song song -> xếp hàng để không đè dòng nhau
  try {
    var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheets()[0];
    var d = JSON.parse(e.postData.contents);

    var START = 3; // dữ liệu bắt đầu dòng 3 (dòng 1-2 là tiêu đề)

    // Con trỏ "dòng kế tiếp" lưu ở ô Z1 — đọc/ghi O(1), KHÔNG quét cả cột.
    var ptrCell = sheet.getRange('Z1');
    var row = Number(ptrCell.getValue()) || START;
    if (row < START) row = START;

    // Lưới an toàn: nếu con trỏ lệch (ai đó xóa/chèn dòng thủ công), nhích tới
    // ô C trống thật. Bình thường vòng này chạy 0 lần nên vẫn O(1).
    while (sheet.getRange(row, 3).getValue() !== '') {
      row++;
    }

    sheet.getRange(row, 2).setValue(new Date());             // B = Date
    sheet.getRange(row, 3).setValue(d.mailLine || '');       // C = FullAcess
    sheet.getRange(row, 8).setValue(d.checkoutUrl || '');    // H = CheckOut
    sheet.getRange(row, 13).setValue(d.errorMessage || '');  // M = lý do lỗi

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

// Dò dấu ngăn tham số công thức theo LOCALE của sheet: ghi 1.1 vào ô nháp Z2 rồi
// xem nó hiển thị dạng "1,1" (locale phẩy-thập-phân -> ngăn tham số bằng ';') hay
// "1.1" (-> ','). Không phụ thuộc bảng map locale, đúng cho mọi vùng.
function argSeparator(sheet) {
  var probe = sheet.getRange('Z2'); // ô nháp (Z1 đang giữ con trỏ dòng)
  probe.setValue(1.1);
  var usesComma = probe.getDisplayValue().indexOf(',') !== -1;
  probe.clearContent();
  return usesComma ? ';' : ',';
}
