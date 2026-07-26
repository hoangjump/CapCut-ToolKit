import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  type WheelEvent,
} from 'react';
import { CheckCircle2, LoaderCircle, MonitorUp, RefreshCw, XCircle } from 'lucide-react';
import { workApi, type PaymentBrowserInput, type PaymentSession } from '@/lib/api';
import { Button } from '@/components/ui/button';

const FRAME_WIDTH = 1280;
const FRAME_HEIGHT = 720;

function remaining(expiresAt: string): string {
  const seconds = Math.max(0, Math.ceil((new Date(expiresAt).getTime() - Date.now()) / 1_000));
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

export function PaymentViewer({ token }: { token: string }) {
  const [session, setSession] = useState<PaymentSession | null>(null);
  const [loading, setLoading] = useState(true);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState('');
  const [, tick] = useState(0);

  const load = useCallback(async () => {
    try {
      setSession(await workApi.paymentSession(token));
      setError('');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const timer = window.setInterval(() => {
      tick((value) => value + 1);
      if (session && ['starting', 'ready'].includes(session.status)) void load();
    }, 1_000);
    return () => window.clearInterval(timer);
  }, [load, session]);

  const timeLeft = session ? remaining(session.expiresAt) : '--:--';

  async function start() {
    setStarting(true); setError('');
    try { setSession(await workApi.claimPaymentSession(token)); }
    catch (err) { setError((err as Error).message); }
    finally { setStarting(false); }
  }

  async function close() {
    try { await workApi.closePaymentSession(token); } catch {}
    setSession((value) => value ? { ...value, status: 'closed' } : value);
  }

  if (loading) return <Centered><LoaderCircle className="h-6 w-6 animate-spin" /><span>Đang kiểm tra link thanh toán…</span></Centered>;
  if (error && !session) return <Centered><XCircle className="h-7 w-7 text-destructive" /><strong>Không mở được phiên</strong><span className="text-sm text-muted-foreground">{error}</span></Centered>;
  if (!session) return null;

  if (session.status === 'paid') {
    return <Centered><CheckCircle2 className="h-9 w-9 text-green-600" /><strong>Thanh toán thành công</strong><span className="text-sm text-muted-foreground">Bạn có thể đóng trang này và thả tim trên Telegram để ghi nhận sản lượng.</span></Centered>;
  }
  if (['expired', 'closed'].includes(session.status)) {
    return <Centered><XCircle className="h-7 w-7 text-muted-foreground" /><strong>{session.status === 'expired' ? 'Link đã hết hạn' : 'Phiên đã đóng'}</strong><span className="text-sm text-muted-foreground">Yêu cầu quản lý gửi một link thanh toán mới.</span></Centered>;
  }

  return (
    <main className="flex min-h-screen flex-col bg-background">
      <div className="flex min-h-14 flex-wrap items-center gap-3 border-b px-4 py-2">
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold">Thanh toán CapCut</div>
          <div className="truncate text-xs text-muted-foreground">{session.email}</div>
        </div>
        <div className="ml-auto text-sm tabular-nums">Còn {timeLeft}</div>
        <Button size="sm" variant="outline" onClick={() => void load()}><RefreshCw /> Làm mới</Button>
        {session.status === 'ready' && <Button size="sm" variant="outline" onClick={close}>Đóng phiên</Button>}
      </div>

      {session.status === 'ready' ? (
        <RemotePaymentScreen
          frameEndpoint={workApi.paymentFrameUrl(token)}
          onInput={(input) => workApi.sendPaymentInput(token, input)}
        />
      ) : (
        <div className="flex flex-1 items-center justify-center p-6">
          <div className="w-full max-w-md border bg-card p-6 text-center">
            <MonitorUp className="mx-auto mb-4 h-9 w-9 text-muted-foreground" />
            <div className="font-semibold">Mở màn hình thanh toán</div>
            <p className="mt-2 text-sm text-muted-foreground">Trình duyệt chạy ẩn trong app của quản lý và tự đóng khi hết 15 phút.</p>
            {(error || session.error) && <p className="mt-3 text-sm text-destructive">{error || session.error}</p>}
            <Button className="mt-5" disabled={starting || session.status === 'starting'} onClick={start}>
              {(starting || session.status === 'starting') && <LoaderCircle className="animate-spin" />}
              {starting || session.status === 'starting' ? 'Đang mở…' : session.status === 'failed' ? 'Thử lại' : 'Bắt đầu thanh toán'}
            </Button>
          </div>
        </div>
      )}
    </main>
  );
}

export function RemotePaymentScreen({
  frameEndpoint,
  onInput,
}: {
  frameEndpoint: string;
  onInput: (input: PaymentBrowserInput) => Promise<void>;
}) {
  const [frameUrl, setFrameUrl] = useState('');
  const [frameError, setFrameError] = useState('');
  const screenRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let stopped = false;
    let timer: number | undefined;
    let currentUrl = '';
    const poll = async () => {
      try {
        const response = await fetch(`${frameEndpoint}?t=${Date.now()}`, { cache: 'no-store' });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const nextUrl = URL.createObjectURL(await response.blob());
        if (stopped) { URL.revokeObjectURL(nextUrl); return; }
        if (currentUrl) URL.revokeObjectURL(currentUrl);
        currentUrl = nextUrl;
        setFrameUrl(nextUrl);
        setFrameError('');
        timer = window.setTimeout(poll, 250);
      } catch {
        if (!stopped) {
          setFrameError('Đang chờ hình ảnh từ trình duyệt…');
          timer = window.setTimeout(poll, 700);
        }
      }
    };
    void poll();
    return () => {
      stopped = true;
      if (timer) window.clearTimeout(timer);
      if (currentUrl) URL.revokeObjectURL(currentUrl);
    };
  }, [frameEndpoint]);

  const send = useCallback((input: PaymentBrowserInput) => {
    void onInput(input).catch(() => {});
  }, [onInput]);

  function point(event: MouseEvent<HTMLDivElement>): { x: number; y: number } {
    const rect = event.currentTarget.getBoundingClientRect();
    return {
      x: ((event.clientX - rect.left) / rect.width) * FRAME_WIDTH,
      y: ((event.clientY - rect.top) / rect.height) * FRAME_HEIGHT,
    };
  }

  function click(event: MouseEvent<HTMLDivElement>) {
    event.preventDefault();
    screenRef.current?.focus();
    send({ type: 'click', ...point(event), button: event.button === 2 ? 'right' : 'left' });
  }

  function wheel(event: WheelEvent<HTMLDivElement>) {
    event.preventDefault();
    send({ type: 'wheel', deltaX: event.deltaX, deltaY: event.deltaY });
  }

  function keyDown(event: KeyboardEvent<HTMLDivElement>) {
    event.preventDefault();
    send({
      type: 'key',
      key: event.key,
      altKey: event.altKey,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      shiftKey: event.shiftKey,
    });
  }

  function paste(event: ClipboardEvent<HTMLDivElement>) {
    event.preventDefault();
    send({ type: 'text', text: event.clipboardData.getData('text') });
  }

  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 bg-neutral-950 p-2 sm:p-4">
      <div
        ref={screenRef}
        tabIndex={0}
        role="application"
        aria-label="Màn hình thanh toán"
        className="relative aspect-video w-full max-w-[1280px] overflow-hidden border border-neutral-700 bg-black outline-none focus:border-neutral-400"
        onClick={click}
        onContextMenu={(event) => { event.preventDefault(); click(event); }}
        onWheel={wheel}
        onKeyDown={keyDown}
        onPaste={paste}
      >
        {frameUrl
          ? <img src={frameUrl} alt="Màn hình thanh toán" draggable={false} className="h-full w-full select-none object-fill" />
          : <div className="flex h-full items-center justify-center text-sm text-neutral-400"><LoaderCircle className="mr-2 h-4 w-4 animate-spin" />{frameError || 'Đang tải màn hình…'}</div>}
      </div>
      <div className="text-xs text-neutral-400">Bấm vào màn hình để thao tác. Có thể cuộn, nhập phím và dán nội dung.</div>
    </div>
  );
}

function Centered({ children }: { children: ReactNode }) {
  return <main className="flex min-h-screen flex-col items-center justify-center gap-3 bg-background p-6 text-center">{children}</main>;
}
