import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Play, Square, Copy, RefreshCw, Save, Plus, Trash2 } from 'lucide-react';
import { checkerApi, type CheckerConfig, type CheckerResult, type CheckerTeamProgress } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';

export function CheckerTab() {
  const [cfg, setCfg] = useState<CheckerConfig | null>(null);
  const [running, setRunning] = useState(false);
  const [stats, setStats] = useState({ total: 0, done: 0, ok: 0, fail: 0 });
  const [results, setResults] = useState<CheckerResult[]>([]);
  const [teamProgress, setTeamProgress] = useState<CheckerTeamProgress[]>([]);
  const [logs, setLogs] = useState<string[]>([]);
  const [count, setCount] = useState(1);
  const [accountsText, setAccountsText] = useState('');
  const [products, setProducts] = useState<any[]>([]);
  const [resultView, setResultView] = useState<'table' | 'text'>('table');
  const logRef = useRef<HTMLDivElement>(null);
  const esRef = useRef<EventSource | null>(null);

  // Load config
  useEffect(() => {
    checkerApi.config().then(setCfg).catch(() => {});
  }, []);

  // SSE connection
  useEffect(() => {
    const es = new EventSource('/api/checker/events');
    esRef.current = es;
    es.onmessage = (e) => {
      const data = JSON.parse(e.data);
      if (data.type === 'state') {
        setRunning(data.running);
        setStats(data.stats);
        setResults(data.results);
        setTeamProgress(data.teams ?? []);
      } else if (data.type === 'log') {
        setLogs((prev) => {
          const next = [...prev, `${data.time.slice(11, 19)} ${data.msg}`];
          return next.length > 500 ? next.slice(-500) : next;
        });
      }
    };
    return () => es.close();
  }, []);

  // Auto-scroll log
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [logs]);

  const updateCfg = useCallback((patch: Partial<CheckerConfig>) => {
    setCfg((prev) => prev ? { ...prev, ...patch } : prev);
  }, []);

  const saveCfg = useCallback(async () => {
    if (!cfg) return;
    try {
      const saved = await checkerApi.saveConfig(cfg);
      setCfg(saved);
      toast.success('Đã lưu cấu hình');
    } catch (e) {
      toast.error((e as Error).message);
    }
  }, [cfg]);

  const loadProducts = useCallback(async (provider?: string) => {
    try {
      const { products: p } = await checkerApi.products(provider || cfg?.mailProvider);
      setProducts(p);
      toast.success(`${p.length} sản phẩm`);
    } catch (e) {
      toast.error((e as Error).message);
    }
  }, [cfg?.mailProvider]);

  const handleRun = useCallback(async () => {
    if (!cfg) return;
    try {
      const saved = await checkerApi.saveConfig(cfg);
      setCfg(saved);
      setLogs([]);
      const body: any = {};
      if (accountsText.trim()) {
        body.accounts = accountsText;
      } else {
        body.count = count;
      }
      await checkerApi.run(body);
    } catch (e) {
      toast.error((e as Error).message);
    }
  }, [cfg, count, accountsText]);

  const handleStop = useCallback(async () => {
    try {
      await checkerApi.stop();
    } catch (e) {
      toast.error((e as Error).message);
    }
  }, []);

  const okText = useCallback(() => {
    const ok = results.filter((r) => r.ok);
    const grouped = teamProgress.filter((t) => t.link).length > 1;
    if (!grouped) return ok.map((r) => `${r.email}|${r.password}`).join('\n');
    return teamProgress
      .map((t, i) => {
        const lines = ok.filter((r) => r.team === i + 1).map((r) => `${r.email}|${r.password}`);
        return [`# Link ${i + 1}: ${t.link}`, ...lines].join('\n');
      })
      .join('\n\n');
  }, [results, teamProgress]);

  const copyEmailPass = useCallback(() => {
    navigator.clipboard.writeText(okText());
    toast.success(`Đã copy ${results.filter((r) => r.ok).length} account đạt`);
  }, [okText, results]);

  if (!cfg) return <div className="text-sm text-muted-foreground">Đang tải...</div>;

  const okResults = results.filter((r) => r.ok);
  const linkTotal = cfg.teams.reduce((n, t) => n + (t.link.trim() ? t.count : 0), 0);
  const setTeam = (i: number, patch: Partial<{ link: string; count: number }>) =>
    updateCfg({ teams: cfg.teams.map((t, j) => (j === i ? { ...t, ...patch } : t)) });

  return (
    <div className="space-y-6">
      {/* Config */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Cấu hình</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label>Nguồn mail</Label>
              <Select value={cfg.mailProvider} onValueChange={(v) => updateCfg({ mailProvider: v as 'stk' | 'dvfb' })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="stk">Selltaikhoan</SelectItem>
                  <SelectItem value="dvfb">Dongvanfb</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {cfg.mailProvider === 'stk' ? (
              <>
                <div className="space-y-2">
                  <Label>API key STK</Label>
                  <Input type="password" value={cfg.stkApiKey} onChange={(e) => updateCfg({ stkApiKey: e.target.value })} placeholder="Selltaikhoan API key" />
                </div>
                <div className="space-y-2">
                  <Label>ID sản phẩm STK</Label>
                  <div className="flex gap-2">
                    <Input value={cfg.stkProduct} onChange={(e) => updateCfg({ stkProduct: e.target.value })} placeholder="ID sản phẩm" />
                    <Button variant="outline" size="sm" onClick={() => loadProducts('stk')}>
                      <RefreshCw className="mr-1 h-3 w-3" />DS
                    </Button>
                  </div>
                </div>
              </>
            ) : (
              <>
                <div className="space-y-2">
                  <Label>API key DVFB</Label>
                  <Input type="password" value={cfg.dvfbApiKey} onChange={(e) => updateCfg({ dvfbApiKey: e.target.value })} placeholder="Dongvanfb API key" />
                </div>
                <div className="space-y-2">
                  <Label>Account type DVFB</Label>
                  <div className="flex gap-2">
                    <Input value={cfg.dvfbProduct} onChange={(e) => updateCfg({ dvfbProduct: e.target.value })} placeholder="account_type (VD: 1, 5)" />
                    <Button variant="outline" size="sm" onClick={() => loadProducts('dvfb')}>
                      <RefreshCw className="mr-1 h-3 w-3" />DS
                    </Button>
                  </div>
                </div>
              </>
            )}

            <div className="space-y-2">
              <Label>Credit tối thiểu để tính join thành công</Label>
              <Input type="number" value={cfg.minCredit} onChange={(e) => updateCfg({ minCredit: Number(e.target.value) })} />
            </div>

            <div className="space-y-2">
              <Label>Proxy key (MKT, phẩy ngăn cách)</Label>
              <Input value={cfg.proxyKeys} onChange={(e) => updateCfg({ proxyKeys: e.target.value })} placeholder="key1,key2 (trống = direct)" />
            </div>

            <div className="flex items-center gap-3">
              <Switch checked={cfg.rotateEach} onCheckedChange={(v) => updateCfg({ rotateEach: v })} />
              <Label>Xoay IP mỗi account</Label>
            </div>

            <div className="space-y-2">
              <Label>Nghỉ giữa mỗi account (ms)</Label>
              <Input type="number" value={cfg.delayMs} onChange={(e) => updateCfg({ delayMs: Number(e.target.value) })} />
            </div>
          </div>

          <div className="space-y-2">
            <Label>Link mời team + số account cần cho mỗi link</Label>
            <p className="text-xs text-muted-foreground">
              Join chỉ tính thành công khi account có credit ≥ {cfg.minCredit} hoặc có Pro Team. Account không đạt sẽ tự mua mail khác bù cho đủ.
            </p>
            {cfg.teams.map((t, i) => (
              <div key={i} className="flex items-center gap-2">
                <span className="w-6 text-xs text-muted-foreground">{i + 1}.</span>
                <Input value={t.link} onChange={(e) => setTeam(i, { link: e.target.value })} placeholder="https://www.capcut.com/sv2/..." className="flex-1" disabled={running} />
                <Input type="number" min={1} value={t.count} onChange={(e) => setTeam(i, { count: Number(e.target.value) })} className="w-20" disabled={running} aria-label="Số account" />
                <Button variant="outline" size="sm" onClick={() => updateCfg({ teams: cfg.teams.filter((_, j) => j !== i) })} disabled={running} aria-label="Xoá link">
                  <Trash2 className="h-3 w-3" />
                </Button>
              </div>
            ))}
            <div className="flex flex-wrap items-center gap-3">
              <Button variant="outline" size="sm" onClick={() => updateCfg({ teams: [...cfg.teams, { link: '', count: 1 }] })} disabled={running}>
                <Plus className="mr-1 h-3 w-3" />Thêm link
              </Button>
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                Thử tối đa
                <Input type="number" min={1} value={cfg.maxTriesPerAccount} onChange={(e) => updateCfg({ maxTriesPerAccount: Number(e.target.value) })} className="h-8 w-16" />
                lần cho mỗi account cần đạt
              </div>
            </div>
          </div>

          {products.length > 0 && (
            <div className="rounded border p-3 text-xs">
              <div className="mb-1 font-medium">Danh sách sản phẩm:</div>
              {products.map((p: any, i: number) => (
                <div key={i} className="text-muted-foreground">
                  {p.id ?? p.account_type ?? '?'} — {p.name ?? p.title ?? JSON.stringify(p).slice(0, 80)}
                  {p.price != null && ` — ${p.price}`}
                  {p.amount != null && ` (${p.amount})`}
                </div>
              ))}
            </div>
          )}

          <Button onClick={saveCfg} size="sm">
            <Save className="mr-1 h-3 w-3" />Lưu cấu hình
          </Button>
        </CardContent>
      </Card>

      {/* Run */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Chạy</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-end gap-3">
            {linkTotal > 0 ? (
              <div className="pb-2 text-sm">
                Cần <b>{linkTotal}</b> account đạt cho {cfg.teams.filter((t) => t.link.trim()).length} link
              </div>
            ) : (
              <div className="space-y-2">
                <Label>Số lượng (không join team)</Label>
                <Input type="number" min={1} value={count} onChange={(e) => setCount(Number(e.target.value))} className="w-24" disabled={running} />
              </div>
            )}
            {!running ? (
              <Button onClick={handleRun} className="gap-1">
                <Play className="h-4 w-4" />Chạy
              </Button>
            ) : (
              <Button onClick={handleStop} variant="destructive" className="gap-1">
                <Square className="h-4 w-4" />Dừng
              </Button>
            )}
          </div>

          <div className="space-y-2">
            <Label>Account có sẵn (dùng trước, hết thì tự mua): email|pass hoặc email|pass|refresh|client</Label>
            <Textarea
              value={accountsText}
              onChange={(e) => setAccountsText(e.target.value)}
              rows={3}
              placeholder="email1|pass1&#10;email2|pass2|refresh_token|client_id"
              disabled={running}
            />
          </div>

          {/* Stats */}
          {(running || stats.done > 0) && (
            <div className="flex gap-3 text-sm">
              <Badge variant="outline">Cần: {stats.total}</Badge>
              <Badge variant="outline">Đã chạy: {stats.done}</Badge>
              <Badge variant="default" className="bg-green-600">{stats.ok} đạt</Badge>
              {stats.fail > 0 && <Badge variant="danger">{stats.fail} không đạt</Badge>}
            </div>
          )}
          {teamProgress.some((t) => t.link) && (
            <div className="space-y-1 text-xs">
              {teamProgress.map((t, i) => (
                <div key={i} className="flex items-center gap-2">
                  <span className="w-14 shrink-0 font-medium">Link {i + 1}</span>
                  <span className="min-w-0 flex-1 truncate font-mono text-muted-foreground">{t.link}</span>
                  <Badge variant={t.ok >= t.target ? 'success' : 'outline'}>{t.ok}/{t.target}</Badge>
                  <span className="w-14 text-right text-muted-foreground">thử {t.tries}</span>
                </div>
              ))}
            </div>
          )}

          {/* Log */}
          <div
            ref={logRef}
            className="h-48 overflow-y-auto rounded border bg-muted/30 p-2 font-mono text-xs leading-relaxed"
          >
            {logs.length === 0 ? (
              <span className="text-muted-foreground">Chưa có log</span>
            ) : (
              logs.map((l, i) => <div key={i}>{l}</div>)
            )}
          </div>
        </CardContent>
      </Card>

      {/* Results */}
      {results.length > 0 && (
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-3">
            <CardTitle className="text-base">Kết quả ({okResults.length} OK / {results.length})</CardTitle>
            <div className="flex gap-2">
              <Button
                variant={resultView === 'table' ? 'default' : 'outline'}
                size="sm"
                onClick={() => setResultView('table')}
              >Bảng</Button>
              <Button
                variant={resultView === 'text' ? 'default' : 'outline'}
                size="sm"
                onClick={() => setResultView('text')}
              >Text</Button>
              <Button variant="outline" size="sm" onClick={copyEmailPass} className="gap-1">
                <Copy className="h-3 w-3" />Copy email|pass
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            {resultView === 'table' ? (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>#</TableHead>
                      <TableHead>Link</TableHead>
                      <TableHead>Kết quả</TableHead>
                      <TableHead>Email</TableHead>
                      <TableHead>UID</TableHead>
                      <TableHead>Pro</TableHead>
                      <TableHead>Trial</TableHead>
                      <TableHead>Credit</TableHead>
                      <TableHead>Joined</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {results.map((r, i) => (
                      <TableRow key={i} className={r.ok ? '' : 'text-destructive'}>
                        <TableCell>{i + 1}</TableCell>
                        <TableCell>{r.team}</TableCell>
                        <TableCell>{r.ok ? 'ĐẠT' : 'HỎNG'}</TableCell>
                        <TableCell className="font-mono text-xs">{r.email}</TableCell>
                        <TableCell className="font-mono text-xs">{r.uid}</TableCell>
                        <TableCell>{r.vip}</TableCell>
                        <TableCell>{r.trial}</TableCell>
                        <TableCell>{r.credit}</TableCell>
                        <TableCell>{r.joined}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            ) : (
              <Textarea
                readOnly
                rows={15}
                className="font-mono text-xs"
                value={okText()}
              />
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
