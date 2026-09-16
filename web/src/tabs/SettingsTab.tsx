import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Wifi } from 'lucide-react';
import { settingsApi, mailApi, sellApi, smsbowerApi, mktApi, type SmsbowerRest } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

// Bảng tên gợi ý cho mã service SmsBower (chuẩn sms-activate). Chỉ để HIỂN THỊ
// cho dễ nhận diện — mã thô luôn hiện kèm nên không sợ nhầm. OpenAI/ChatGPT là
// 'dr'. Mã nào không có trong bảng thì chỉ hiện mã thô.
const SMS_SERVICE_NAMES: Record<string, string> = {
  dr: 'OpenAI / ChatGPT',
  go: 'Google / Gmail / YouTube',
  tg: 'Telegram',
  wa: 'WhatsApp',
  ig: 'Instagram',
  fb: 'Facebook',
  tw: 'Twitter / X',
  mm: 'Microsoft / Outlook',
  mb: 'Yahoo',
  am: 'Amazon',
  ds: 'Discord',
  vi: 'Viber',
  ub: 'Uber',
  ts: 'PayPal',
  ot: 'Khác (bất kỳ)',
};

/** Một ô nhập API key: chỉ hiện trạng thái đã lưu (dạng che), không bao giờ đổ
 *  key thật xuống trình duyệt. Để trống rồi bấm Lưu = xoá key. */
function KeyField({ label, state, hint, placeholder, onSave }: {
  label: string;
  state: string;
  hint?: string;
  placeholder: string;
  onSave: (value: string) => Promise<void>;
}) {
  const [value, setValue] = useState('');
  const [saving, setSaving] = useState(false);
  async function save() {
    setSaving(true);
    try { await onSave(value.trim()); setValue(''); } finally { setSaving(false); }
  }
  return (
    <div className="space-y-1.5">
      <Label>{label} <span className="font-normal text-muted-foreground">{state}</span></Label>
      <div className="flex gap-2">
        <Input type="password" placeholder={placeholder} value={value} onChange={(e) => setValue(e.target.value)} />
        <Button onClick={save} disabled={saving}>{saving ? 'Đang lưu...' : 'Lưu'}</Button>
      </div>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

/** Card gập được — mặc định gập để tab không thành bức tường ô nhập. */
function Section({ title, defaultOpen = false, children }: { title: string; defaultOpen?: boolean; children: React.ReactNode }) {
  return (
    <details open={defaultOpen} className="group rounded-xl border bg-card">
      <summary className="flex cursor-pointer list-none items-center justify-between px-5 py-4 [&::-webkit-details-marker]:hidden">
        <span className="text-base font-semibold">{title}</span>
        <span className="text-xs text-muted-foreground group-open:hidden">Mở</span>
        <span className="hidden text-xs text-muted-foreground group-open:inline">Thu gọn</span>
      </summary>
      <div className="space-y-4 px-5 pb-5">{children}</div>
    </details>
  );
}

export function SettingsTab() {
  const [state, setState] = useState({
    mail: '(chưa có)', sell: '(chưa có)', sms: '(chưa có)', temp: '(chưa có)',
    mkt: '(chưa có)', sheet: '(chưa có)', telegram: '(chưa có)',
  });
  const [sheetUrl, setSheetUrl] = useState('');
  const [tgToken, setTgToken] = useState('');
  const [tgChatId, setTgChatId] = useState('');
  const [balances, setBalances] = useState<Record<string, string>>({});
  const [smsRests, setSmsRests] = useState<SmsbowerRest[]>([]);
  const [smsRestState, setSmsRestState] = useState('');

  async function load() {
    try {
      const s = await settingsApi.get();
      setState({
        mail: s.hasKey ? `(đã lưu: ${s.masked})` : '(chưa có)',
        sell: s.hasSelltaikhoanKey ? `(đã lưu: ${s.selltaikhoanMasked})` : '(chưa có)',
        sms: s.hasSmsbowerKey ? `(đã lưu: ${s.smsbowerMasked})` : '(chưa có)',
        temp: s.hasTempmailToken ? `(đã lưu: ${s.tempmailMasked})` : '(chưa có)',
        mkt: s.hasMktproxyKey ? `(đã lưu: ${s.mktproxyMasked})` : '(chưa có)',
        sheet: s.sheetWebhookUrl ? '(đã lưu)' : '(chưa có)',
        telegram: s.hasTelegram ? `(đã lưu: ${s.telegramMasked})` : '(chưa có)',
      });
      setSheetUrl(s.sheetWebhookUrl || '');
      setTgChatId(s.telegramChatId || '');
    } catch (e) { toast.error((e as Error).message); }
  }
  useEffect(() => { void load(); }, []);

  function saver(field: string, label: string) {
    return async (value: string) => {
      try {
        await settingsApi.save({ [field]: value });
        toast.success(value ? `Đã lưu ${label}` : `Đã xoá ${label}`);
        await load();
      } catch (e) { toast.error((e as Error).message); }
    };
  }

  async function balance(key: string, run: () => Promise<{ balance: number | string }>) {
    try {
      const r = await run();
      setBalances((b) => ({ ...b, [key]: `${r.balance}đ` }));
    } catch (e) { toast.error((e as Error).message); }
  }

  async function loadSmsRests() {
    setSmsRestState('(đang tải...)');
    try {
      // Nhiều hàng nhất lên đầu — thứ đang có kho mới là thứ mua được.
      const sorted = [...(await smsbowerApi.rests('gmail.com')).rests].sort((a, b) => b.count - a.count);
      setSmsRests(sorted);
      setSmsRestState(`(${sorted.length} service)`);
    } catch (e) { setSmsRestState(''); toast.error((e as Error).message); }
  }

  async function saveSheet() {
    try {
      await settingsApi.save({ sheetWebhookUrl: sheetUrl.trim() });
      toast.success(sheetUrl.trim() ? 'Đã lưu Sheet URL' : 'Đã xoá Sheet URL');
      await load();
    } catch (e) { toast.error((e as Error).message); }
  }

  async function saveTelegram() {
    try {
      await settingsApi.save({
        ...(tgToken.trim() ? { telegramBotToken: tgToken.trim() } : {}),
        telegramChatId: tgChatId.trim(),
      });
      setTgToken('');
      toast.success('Đã lưu Telegram');
      await load();
    } catch (e) { toast.error((e as Error).message); }
  }

  return (
    <div className="mx-auto grid max-w-2xl grid-cols-1 gap-3">
      <Section title="Nhà cung cấp mail">
          <KeyField
            label="API key dongvanfb" state={state.mail}
            placeholder="Dán API key dongvanfb..."
            onSave={saver('dongvanfbApiKey', 'API key dongvanfb')}
          />
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => balance('mail', mailApi.balance)}>Xem số dư</Button>
            <span className="text-sm font-semibold text-primary">{balances.mail}</span>
          </div>
          <KeyField
            label="API key selltaikhoan" state={state.sell}
            hint="Nhà cung cấp mail thứ 2 (Outlook rẻ hơn). Mail cùng định dạng nên đọc OTP dùng chung."
            placeholder="Dán API key selltaikhoan..."
            onSave={saver('selltaikhoanApiKey', 'API key selltaikhoan')}
          />
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => balance('sell', sellApi.balance)}>Xem số dư</Button>
            <span className="text-sm font-semibold text-primary">{balances.sell}</span>
          </div>
          <KeyField
            label="API token tempmail.id.vn" state={state.temp}
            hint='Mail TẠM có API đọc OTP thẳng (không mở tab). Dùng cho flow "CapCut — đăng ký bằng mail tạm". Tạo token ở trang cá nhân tempmail.id.vn (chỉ hiện 1 lần).'
            placeholder="Dán API token tempmail (dạng 12318|xxxx...)"
            onSave={saver('tempmailApiToken', 'API token tempmail')}
          />
      </Section>

      <Section title="Proxy">
          <KeyField
            label="API key tài khoản mktproxy" state={state.mkt}
            hint='Dùng để mua proxy và xem số dư. Đây là key TÀI KHOẢN (mkt_...), không phải key của từng proxy.'
            placeholder="Dán API key tài khoản mktproxy..."
            onSave={saver('mktproxyApiKey', 'API key mktproxy')}
          />
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => balance('mkt', mktApi.balance)}>
              <Wifi className="h-4 w-4" /> Xem số dư
            </Button>
            <span className="text-sm font-semibold text-primary">{balances.mkt}</span>
          </div>
      </Section>

      <Section title="Thuê số nhận OTP">
          <KeyField
            label="API key SmsBower" state={state.sms}
            hint='Thuê gmail nhận OTP theo service (dùng cho flow ChatGPT). Đặt "Mã service" trong tab Chạy tự động.'
            placeholder="Dán API key SmsBower..."
            onSave={saver('smsbowerApiKey', 'API key SmsBower')}
          />
          <Button variant="outline" size="sm" onClick={loadSmsRests}>
            Xem tồn kho gmail <span className="font-normal text-muted-foreground">{smsRestState}</span>
          </Button>
          {smsRests.length > 0 && (
            <div className="max-h-48 overflow-auto rounded-lg border p-2 text-xs">
              {smsRests.map((r) => (
                <div key={`${r.service}-${r.domain}`} className="flex justify-between gap-2 py-0.5">
                  <span className="truncate">
                    <span className="font-mono font-medium">{r.service}</span>
                    {SMS_SERVICE_NAMES[r.service] && <span className="text-muted-foreground"> · {SMS_SERVICE_NAMES[r.service]}</span>}
                  </span>
                  <span className="shrink-0 text-muted-foreground">{r.price}đ · kho {r.count}</span>
                </div>
              ))}
              <p className="mt-1 text-muted-foreground">
                Cột trái (mã) là "Mã service" điền ở tab Chạy tự động. ChatGPT = <b>dr</b>.
              </p>
            </div>
          )}
          {smsRestState === '(0 service)' && (
            <p className="text-xs text-destructive">SmsBower không trả service nào cho gmail.com — có thể hết hàng hoặc sai key.</p>
          )}
      </Section>

      <Section title="Google Sheet & Telegram" defaultOpen>
          <div className="space-y-1.5">
            <Label>Google Sheet URL <span className="font-normal text-muted-foreground">{state.sheet}</span></Label>
            <div className="flex gap-2">
              <Input placeholder=".../exec" value={sheetUrl} onChange={(e) => setSheetUrl(e.target.value)} />
              <Button onClick={saveSheet}>Lưu</Button>
            </div>
            <p className="text-xs text-muted-foreground">
              URL Web App của Apps Script gắn trên Sheet tổng. Sheet riêng của nhân viên dùng chung URL này —
              khai link từng file ở tab Công việc.
            </p>
          </div>
          <div className="space-y-1.5">
            <Label>Telegram báo thành công <span className="font-normal text-muted-foreground">{state.telegram}</span></Label>
            <Input type="password" placeholder="Bot token (123456:ABC...) — để trống nếu không đổi" value={tgToken} onChange={(e) => setTgToken(e.target.value)} />
            <div className="flex gap-2">
              <Input placeholder="Chat ID (-100... hoặc id cá nhân)" value={tgChatId} onChange={(e) => setTgChatId(e.target.value)} />
              <Button onClick={saveTelegram}>Lưu</Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Mỗi account đăng ký thành công gửi 1 tin nhắn gồm email và link thanh toán. Bot phân việc cho
              nhân viên cấu hình riêng ở tab Công việc.
            </p>
          </div>
      </Section>
    </div>
  );
}
