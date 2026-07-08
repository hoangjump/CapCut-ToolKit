import { useEffect, useRef, useState } from 'react';
import { ChevronUp, Pause, Play, Trash2, Search } from 'lucide-react';
import type { LogEntry } from '@/lib/api';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

const LEVEL_ORDER: Record<string, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const LOG_MAX = 2000;

const LEVEL_COLOR: Record<string, string> = {
  debug: 'text-slate-500',
  info: 'text-slate-300',
  warn: 'text-amber-400',
  error: 'text-rose-400',
};

/** Panel log realtime nối SSE /api/logs/stream. onActivity kích hoạt khi thấy
 *  dòng scope "browser" (mở/đóng) để tab Hồ sơ tự refresh chấm trạng thái. */
export function LogDrawer({ onActivity }: { onActivity?: () => void }) {
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [paused, setPaused] = useState(false);
  const [connected, setConnected] = useState(false);
  const [level, setLevel] = useState('info');
  const [filter, setFilter] = useState('');
  const bodyRef = useRef<HTMLDivElement>(null);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  const activityRef = useRef(onActivity);
  activityRef.current = onActivity;

  useEffect(() => {
    let src: EventSource | null = null;
    try {
      src = new EventSource('/api/logs/stream');
      src.onopen = () => setConnected(true);
      src.onerror = () => setConnected(false);
      src.onmessage = (ev) => {
        try {
          const e = JSON.parse(ev.data) as LogEntry;
          if (!pausedRef.current) {
            setEntries((prev) => {
              const next = [...prev, e];
              return next.length > LOG_MAX ? next.slice(-LOG_MAX) : next;
            });
          }
          if (e.scope === 'browser' && /(launching|mở|đóng|opened|closed)/i.test(e.msg)) {
            activityRef.current?.();
          }
        } catch {}
      };
    } catch {}
    return () => src?.close();
  }, []);

  const visible = entries.filter((e) => {
    if ((LEVEL_ORDER[e.level] ?? 1) < (LEVEL_ORDER[level] ?? 0)) return false;
    const q = filter.trim().toLowerCase();
    if (q && !`${e.scope} ${e.msg}`.toLowerCase().includes(q)) return false;
    return true;
  });

  useEffect(() => {
    if (open && !paused && bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
  }, [visible.length, open, paused]);

  const stop = (e: React.MouseEvent) => e.stopPropagation();

  return (
    <div className="fixed bottom-0 left-0 right-0 z-40 border-t bg-white shadow-[0_-6px_24px_rgba(15,23,42,0.08)]">
      {/* Thanh điều khiển */}
      <div
        className="flex h-11 cursor-pointer select-none items-center gap-3 px-4"
        onClick={() => setOpen((o) => !o)}
      >
        <span className="relative flex h-2.5 w-2.5">
          {connected && <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-green-400 opacity-60" />}
          <span className={cn('relative inline-flex h-2.5 w-2.5 rounded-full', connected ? 'bg-green-500' : 'bg-slate-400')} />
        </span>
        <span className="text-sm font-semibold">Log</span>
        <span className="text-xs text-muted-foreground">
          {visible.length ? `${visible.length} dòng` : ''}{paused ? ' · đã dừng' : ''}
        </span>

        {open && (
          <div className="no-drag ml-3 flex flex-1 items-center gap-2" onClick={stop}>
            <Select value={level} onValueChange={setLevel}>
              <SelectTrigger className="h-8 w-28"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="debug">debug+</SelectItem>
                <SelectItem value="info">info+</SelectItem>
                <SelectItem value="warn">warn+</SelectItem>
                <SelectItem value="error">error</SelectItem>
              </SelectContent>
            </Select>
            <div className="relative max-w-sm flex-1">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <input
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="Lọc theo scope / nội dung..."
                className="h-8 w-full rounded-md border border-input bg-transparent pl-8 pr-3 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              />
            </div>
            <Button size="sm" variant="outline" onClick={() => setPaused((p) => !p)}>
              {paused ? <><Play className="h-3.5 w-3.5" /> Tiếp</> : <><Pause className="h-3.5 w-3.5" /> Dừng</>}
            </Button>
            <Button size="sm" variant="outline" onClick={() => setEntries([])}>
              <Trash2 className="h-3.5 w-3.5" /> Xóa
            </Button>
          </div>
        )}

        <ChevronUp className={cn('ml-auto h-4 w-4 text-muted-foreground transition-transform', open && 'rotate-180')} />
      </div>

      {/* Thân log (terminal) */}
      {open && (
        <div ref={bodyRef} className="h-72 overflow-auto bg-slate-950 px-4 py-3 font-mono text-xs leading-relaxed">
          {visible.length ? (
            visible.map((e, i) => (
              <div key={i} className="flex gap-2 whitespace-pre-wrap break-all py-px">
                <span className="shrink-0 text-slate-600">{e.ts}</span>
                <span className="shrink-0 text-sky-400">[{e.scope}]</span>
                <span className={LEVEL_COLOR[e.level] || 'text-slate-300'}>{e.msg}</span>
              </div>
            ))
          ) : (
            <div className="py-2 text-slate-500">Chưa có log khớp bộ lọc.</div>
          )}
        </div>
      )}
    </div>
  );
}
