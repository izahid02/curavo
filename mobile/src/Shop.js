/**
 * The connected app: Today | Stock | Credit | More.
 * Everything shown comes from the newest locked summary the shop PC left at
 * the cloud (refreshed every 5 minutes while the PC is on); this phone opens
 * it with its own key.  Nothing here can change anything at the shop.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AppState, FlatList, Linking, Pressable, RefreshControl, ScrollView, Text, TextInput, View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { CloudError, fetchSummary, unlink } from './cloud';
import { ago, clock, dayMonth, expiryMonth, inr, parseUtc, stockQty } from './format';
import { Badge, Button, C, Card, Label, Note, s } from './ui';

const REFRESH_MS = 60 * 1000;
const STALE_MIN = 30;

export default function Shop({ link, notifications, onEnableNotifications, onDisconnected }) {
  const insets = useSafeAreaInsets();
  const [tab, setTab] = useState('today');
  const [data, setData] = useState(null);          // {summary, updatedAt}
  const [waiting, setWaiting] = useState(false);   // connected, no figures yet
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await fetchSummary(link);
      if (r) { setData(r); setWaiting(false); } else setWaiting(true);
      setError('');
    } catch (e) {
      if (e instanceof CloudError && e.status === 401) { onDisconnected(e.message); return; }
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [link, onDisconnected]);

  // On open, every minute while open, and whenever the app comes back to the front.
  useEffect(() => {
    load();
    const t = setInterval(load, REFRESH_MS);
    const sub = AppState.addEventListener('change', (st) => { if (st === 'active') load(); });
    return () => { clearInterval(t); sub.remove(); };
  }, [load]);

  const onRefresh = useCallback(async () => { setRefreshing(true); await load(); setRefreshing(false); }, [load]);

  const sm = data?.summary;
  const madeAt = parseUtc(sm?.generated_at);
  const stale = madeAt && (Date.now() - madeAt.getTime()) > STALE_MIN * 60 * 1000;

  let body;
  if (loading && !sm) {
    body = <Centered><Text style={s.body}>Opening your shop&apos;s figures…</Text></Centered>;
  } else if (!sm) {
    body = (
      <ScrollView contentContainerStyle={{ padding: 16 }} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}>
        {error ? <Note tone="danger">{error}</Note> : null}
        {waiting && (
          <Note tone="info">
            Connected. The first figures arrive within 5 minutes, as long as the shop PC is switched on
            and online. Pull down to check again.
          </Note>
        )}
      </ScrollView>
    );
  } else if (sm.restricted) {
    body = (
      <ScrollView contentContainerStyle={{ padding: 16 }} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}>
        <Card>
          <Text style={{ fontSize: 18, fontWeight: '700', color: C.text, marginBottom: 6 }}>Owner app paused</Text>
          <Text style={s.body}>
            {sm.licence?.headline || 'The Curavo subscription has ended.'} Billing at the shop keeps working.
            Renew the subscription and the figures come back here within a few minutes.
          </Text>
        </Card>
        <Note tone="info">To renew, contact ARZ Solutions with your shop code {sm.shop?.code}.</Note>
      </ScrollView>
    );
  } else {
    const common = { sm, refreshing, onRefresh };
    body = {
      today: <Today {...common} />,
      stock: <Stock {...common} />,
      credit: <Credit {...common} />,
      more: null,
    }[tab];
  }
  if (tab === 'more') {
    body = (
      <More link={link} sm={sm} notifications={notifications}
        onEnableNotifications={onEnableNotifications} onDisconnected={onDisconnected} />
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: C.bg }}>
      <View style={{ paddingTop: insets.top + 10, paddingHorizontal: 16, paddingBottom: 10, backgroundColor: C.card, borderBottomWidth: 1, borderColor: C.line }}>
        <Text style={{ fontSize: 18, fontWeight: '700', color: C.text }} numberOfLines={1}>
          {sm?.shop?.name || link.shopName || 'Your shop'}
        </Text>
        <Text style={{ fontSize: 12.5, color: stale ? C.warn : C.sub, marginTop: 2 }}>
          {madeAt ? `Figures from ${clock(madeAt)} · ${ago(madeAt)}` : 'Waiting for figures'}
        </Text>
      </View>
      {stale && tab !== 'more' && (
        <View style={{ backgroundColor: C.warnBg, paddingHorizontal: 16, paddingVertical: 8 }}>
          <Text style={{ color: C.warn, fontSize: 12.5 }}>
            The shop PC has not sent new figures since {clock(madeAt)}. It may be off or offline.
          </Text>
        </View>
      )}
      {!!error && sm && tab !== 'more' && (
        <View style={{ backgroundColor: C.dangerBg, paddingHorizontal: 16, paddingVertical: 8 }}>
          <Text style={{ color: C.danger, fontSize: 12.5 }}>{error} Showing the last figures received.</Text>
        </View>
      )}
      <View style={{ flex: 1 }}>{body}</View>
      <TabBar tab={tab} setTab={setTab} bottom={insets.bottom} counts={sm && !sm.restricted ? attentionTotal(sm) : 0} />
    </View>
  );
}

function Centered({ children }) {
  return <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 }}>{children}</View>;
}

function attentionTotal(sm) {
  const a = sm.attention || {};
  return (a.expired?.length || 0) + (a.expiring_30?.length || 0) + (a.low_stock?.length || 0)
    + (a.supplier_due || []).filter((d) => d.days !== null && d.days <= 0).length;
}

function TabBar({ tab, setTab, bottom, counts }) {
  const tabs = [['today', 'Today'], ['stock', 'Stock'], ['credit', 'Credit'], ['more', 'More']];
  return (
    <View style={{ flexDirection: 'row', backgroundColor: C.card, borderTopWidth: 1, borderColor: C.line, paddingBottom: bottom }}>
      {tabs.map(([id, label]) => {
        const on = tab === id;
        return (
          <Pressable key={id} onPress={() => setTab(id)} style={{ flex: 1, alignItems: 'center', paddingVertical: 12 }}
            accessibilityRole="tab" accessibilityState={{ selected: on }}>
            <View style={{ width: 28, height: 4, borderRadius: 2, backgroundColor: on ? C.accent : 'transparent', marginBottom: 6 }} />
            <Text style={{ fontSize: 13.5, fontWeight: on ? '700' : '500', color: on ? C.accent : C.sub }}>
              {label}{id === 'today' && counts ? `  •` : ''}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

// ---------------------------------------------------------------- Today

function Today({ sm, refreshing, onRefresh }) {
  const t = sm.today || {};
  const a = sm.attention || {};
  return (
    <ScrollView contentContainerStyle={{ padding: 16 }} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}>
      <Card style={{ backgroundColor: C.accent, borderColor: C.accent }}>
        <Text style={{ color: 'rgba(255,255,255,0.8)', fontSize: 13, fontWeight: '600' }}>TODAY&apos;S SALES</Text>
        <Text style={{ color: '#fff', fontSize: 34, fontWeight: '700', marginTop: 4 }}>{inr(t.sales, { short: true })}</Text>
        <Text style={{ color: 'rgba(255,255,255,0.85)', fontSize: 13.5, marginTop: 2 }}>
          {t.bills || 0} bill{t.bills === 1 ? '' : 's'}
        </Text>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 14 }}>
          {[['Cash', t.cash], ['UPI', t.upi], ['Credit', t.credit], ['Other', t.other]]
            .filter(([, v], i) => i < 3 || v)
            .map(([k, v]) => (
              <View key={k} style={{ backgroundColor: 'rgba(255,255,255,0.16)', borderRadius: 10, paddingHorizontal: 10, paddingVertical: 6 }}>
                <Text style={{ color: 'rgba(255,255,255,0.8)', fontSize: 11.5 }}>{k}</Text>
                <Text style={{ color: '#fff', fontSize: 14.5, fontWeight: '600' }}>{inr(v, { short: true })}</Text>
              </View>
            ))}
        </View>
      </Card>

      <View style={{ flexDirection: 'row', gap: 12 }}>
        <Card style={{ flex: 1 }}>
          <Label>Yesterday</Label>
          <Text style={{ fontSize: 18, fontWeight: '700', color: C.text }}>{inr(sm.yesterday?.sales, { short: true })}</Text>
          <Text style={{ fontSize: 12.5, color: C.sub }}>{sm.yesterday?.bills || 0} bills</Text>
        </Card>
        <Card style={{ flex: 1 }}>
          <Label>This month</Label>
          <Text style={{ fontSize: 18, fontWeight: '700', color: C.text }}>{inr(sm.month?.sales, { short: true })}</Text>
          <Text style={{ fontSize: 12.5, color: C.sub }}>{sm.month?.bills || 0} bills</Text>
        </Card>
      </View>

      <Card>
        <View style={[s.row, { justifyContent: 'space-between' }]}>
          <Text style={{ fontSize: 14, color: C.text }}>Money out today</Text>
          <Text style={{ fontSize: 15, fontWeight: '700', color: C.text }}>{inr(t.money_out, { short: true })}</Text>
        </View>
        <Text style={{ fontSize: 12, color: C.hint, marginTop: 4 }}>Supplier payments, expenses and salary paid today.</Text>
      </Card>

      <Label style={{ marginTop: 8 }}>Needs attention</Label>
      <Attention title="Expired - still on the shelf" tone="danger" rows={a.expired}
        render={(r) => `${r.name} · ${r.batch} · ${expiryMonth(r.expiry)} · ${stockQty(r.qty, r.strip)}`} />
      <Attention title="Expiring within 30 days (cannot be sold)" tone="warn" rows={a.expiring_30}
        render={(r) => `${r.name} · ${r.batch} · ${expiryMonth(r.expiry)} · ${stockQty(r.qty, r.strip)}${r.supplier ? ` · ${r.supplier}` : ''}`} />
      <Attention title="Expiring within 60 days" tone="info" rows={a.expiring_60}
        render={(r) => `${r.name} · ${expiryMonth(r.expiry)} · ${stockQty(r.qty, r.strip)}`} />
      <Attention title="Low on stock" tone="warn" rows={a.low_stock}
        render={(r) => `${r.name} · ${r.stock} left (minimum ${r.min})`} />
      <Attention title="Supplier payments due (7 days)" tone="info" rows={a.supplier_due}
        render={(r) => `${r.supplier} · ${inr(r.amount)} · ${r.days < 0 ? `${-r.days} days overdue` : r.days === 0 ? 'due today' : `due ${dayMonth(r.due)}`}`} />
      {a.credit_overdue?.patients ? (
        <Card style={{ paddingVertical: 12 }}>
          <View style={[s.row, { justifyContent: 'space-between' }]}>
            <Text style={{ fontSize: 14, color: C.text, flex: 1 }}>Patient credit overdue</Text>
            <Badge tone="danger">{a.credit_overdue.patients} · {inr(a.credit_overdue.amount, { short: true })}</Badge>
          </View>
        </Card>
      ) : null}
      {attentionTotal(sm) === 0 && !(a.expiring_60?.length) && !(a.supplier_due?.length) && !a.credit_overdue?.patients && (
        <Note tone="ok">Nothing needs attention right now.</Note>
      )}

      <Label style={{ marginTop: 8 }}>Latest bills</Label>
      <Card style={{ paddingVertical: 4 }}>
        {(sm.recent_bills || []).length === 0 ? <Text style={[s.body, { paddingVertical: 12 }]}>No bills yet.</Text>
          : sm.recent_bills.map((b, i) => (
            <View key={b.no} style={[s.row, { paddingVertical: 10, borderTopWidth: i ? 1 : 0, borderColor: C.line }]}>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={{ fontSize: 14, color: C.text }} numberOfLines={1}>{b.patient || 'Walk-in'}</Text>
                <Text style={{ fontSize: 12, color: C.hint }}>{b.no} · {clock(parseUtc(b.at))} · {b.mode}</Text>
              </View>
              <Text style={{ fontSize: 14.5, fontWeight: '600', color: C.text }}>{inr(b.amount)}</Text>
            </View>
          ))}
      </Card>
    </ScrollView>
  );
}

function Attention({ title, tone, rows, render }) {
  const [open, setOpen] = useState(false);
  if (!rows || rows.length === 0) return null;
  return (
    <Card style={{ paddingVertical: 12 }}>
      <Pressable onPress={() => setOpen(!open)} style={[s.row, { justifyContent: 'space-between' }]} accessibilityRole="button">
        <Text style={{ fontSize: 14, color: C.text, flex: 1, paddingRight: 8 }}>{title}</Text>
        <Badge tone={tone}>{rows.length}{rows.length >= 50 ? '+' : ''}</Badge>
        <Text style={{ color: C.hint, marginLeft: 8, fontSize: 13 }}>{open ? '▲' : '▼'}</Text>
      </Pressable>
      {open && rows.map((r, i) => (
        <Text key={i} style={{ fontSize: 13, color: C.sub, marginTop: 8, lineHeight: 18 }}>{render(r)}</Text>
      ))}
    </Card>
  );
}

// ---------------------------------------------------------------- Stock

function Stock({ sm, refreshing, onRefresh }) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(null);
  const rows = useMemo(() => {
    const all = sm.stock || [];
    const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return all;
    return all.filter((r) => {
      const hay = `${r.n} ${r.g}`.toLowerCase();
      return words.every((w) => hay.includes(w));
    });
  }, [sm, q]);

  return (
    <View style={{ flex: 1 }}>
      <View style={{ padding: 16, paddingBottom: 8 }}>
        <TextInput value={q} onChangeText={setQ} placeholder="Search medicine or generic name"
          placeholderTextColor={C.hint} style={s.input} autoCorrect={false} clearButtonMode="while-editing" />
        <Text style={{ fontSize: 12, color: C.hint, marginTop: 6 }}>
          {rows.length} of {(sm.stock || []).length} medicines in stock (sellable batches only)
        </Text>
      </View>
      <FlatList
        data={rows}
        keyExtractor={(r, i) => `${r.n}-${i}`}
        contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 16 }}
        keyboardShouldPersistTaps="handled"
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
        initialNumToRender={20}
        ListEmptyComponent={<Text style={[s.body, { textAlign: 'center', marginTop: 24 }]}>No medicine matches “{q}”.</Text>}
        renderItem={({ item: r, index }) => {
          const low = r.min && r.q <= r.min;
          const isOpen = open === index;
          return (
            <Pressable onPress={() => setOpen(isOpen ? null : index)}>
              <Card style={{ paddingVertical: 12, marginBottom: 8 }}>
                <View style={s.row}>
                  <View style={{ flex: 1, minWidth: 0, paddingRight: 8 }}>
                    <Text style={{ fontSize: 15, fontWeight: '600', color: C.text }}>{r.n}</Text>
                    {!!r.g && <Text style={{ fontSize: 12.5, color: C.sub }} numberOfLines={1}>{r.g}</Text>}
                    {!!r.r && <Text style={{ fontSize: 12, color: C.hint }}>Rack {r.r}</Text>}
                  </View>
                  <View style={{ alignItems: 'flex-end' }}>
                    <Text style={{ fontSize: 15, fontWeight: '700', color: low ? C.warn : C.text }}>{stockQty(r.q, r.u)}</Text>
                    {r.u ? <Text style={{ fontSize: 11.5, color: C.hint }}>{r.q} tablets</Text> : null}
                    {low ? <Badge tone="warn">Low</Badge> : null}
                  </View>
                </View>
                {isOpen && (
                  <View style={{ marginTop: 10, borderTopWidth: 1, borderColor: C.line, paddingTop: 8 }}>
                    {r.b.map(([batch, exp, qty, price], i) => (
                      <View key={i} style={[s.row, { paddingVertical: 4 }]}>
                        <Text style={{ flex: 1, fontSize: 13, color: C.text }}>{batch}</Text>
                        <Text style={{ width: 76, fontSize: 13, color: C.sub }}>{expiryMonth(exp)}</Text>
                        <Text style={{ width: 92, fontSize: 13, color: C.sub, textAlign: 'right' }}>{stockQty(qty, r.u)}</Text>
                        <Text style={{ width: 78, fontSize: 13, color: C.text, textAlign: 'right' }}>{inr(price)}</Text>
                      </View>
                    ))}
                    <Text style={{ fontSize: 11.5, color: C.hint, marginTop: 4 }}>
                      Batch · expiry · stock · MRP{r.u ? ' per strip' : ''}
                    </Text>
                  </View>
                )}
              </Card>
            </Pressable>
          );
        }}
      />
    </View>
  );
}

// ---------------------------------------------------------------- Credit

function Credit({ sm, refreshing, onRefresh }) {
  const cr = sm.credit || { total: 0, patients: [] };
  const overdue = cr.patients.filter((p) => p.overdue).length;
  return (
    <FlatList
      data={cr.patients}
      keyExtractor={(p, i) => `${p.name}-${i}`}
      contentContainerStyle={{ padding: 16 }}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
      ListHeaderComponent={(
        <Card>
          <Label>Patients owe the shop</Label>
          <Text style={{ fontSize: 26, fontWeight: '700', color: C.text }}>{inr(cr.total, { short: true })}</Text>
          <Text style={{ fontSize: 13, color: overdue ? C.danger : C.sub, marginTop: 2 }}>
            {cr.patients.length} patient{cr.patients.length === 1 ? '' : 's'}{overdue ? ` · ${overdue} overdue` : ''}
          </Text>
        </Card>
      )}
      ListEmptyComponent={<Note tone="ok">No patient owes the shop money.</Note>}
      renderItem={({ item: p }) => (
        <Card style={{ paddingVertical: 12, marginBottom: 8 }}>
          <View style={s.row}>
            <View style={{ flex: 1, minWidth: 0, paddingRight: 8 }}>
              <Text style={{ fontSize: 15, fontWeight: '600', color: C.text }}>{p.name}</Text>
              <Text style={{ fontSize: 12.5, color: p.overdue ? C.danger : C.sub }}>
                {p.overdue
                  ? `Overdue${p.oldest_due ? ` since ${dayMonth(p.oldest_due)}` : ''}`
                  : (p.oldest_due ? `Due ${dayMonth(p.oldest_due)}` : 'Not yet due')}
              </Text>
            </View>
            <Text style={{ fontSize: 15.5, fontWeight: '700', color: C.text }}>{inr(p.amount)}</Text>
          </View>
          {!!p.phone && (
            <Pressable onPress={() => Linking.openURL(`tel:${p.phone}`).catch(() => {})} style={{ marginTop: 8, alignSelf: 'flex-start' }}>
              <Text style={{ color: C.accent, fontSize: 13.5, fontWeight: '600' }}>Call {p.phone}</Text>
            </Pressable>
          )}
        </Card>
      )}
    />
  );
}

// ---------------------------------------------------------------- More

function More({ link, sm, notifications, onEnableNotifications, onDisconnected }) {
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pushBusy, setPushBusy] = useState(false);
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);

  return (
    <ScrollView contentContainerStyle={{ padding: 16 }}>
      <Card>
        <Label>Shop</Label>
        <Text style={{ fontSize: 16, fontWeight: '700', color: C.text }}>{sm?.shop?.name || link.shopName}</Text>
        <Text style={{ fontSize: 13, color: C.sub, marginTop: 2 }}>Shop code {sm?.shop?.code || link.shopCode}</Text>
        {sm?.licence?.headline ? <Text style={{ fontSize: 13, color: C.sub, marginTop: 6 }}>{sm.licence.headline}</Text> : null}
      </Card>

      <Card>
        <Label>Morning alert</Label>
        <Text style={s.body}>
          Once a day after 9 am: how many medicines are expiring, running low, or supplier payments due.
          It never shows money amounts.
        </Text>
        {notifications === 'on'
          ? <Note tone="ok" style={{ marginTop: 12, marginBottom: 0 }}>On for this phone.</Note>
          : (
            <>
              {notifications === 'unavailable' && (
                <Note tone="warn" style={{ marginTop: 12, marginBottom: 0 }}>
                  Notifications could not be turned on. Allow them for Curavo Owner in the phone&apos;s settings.
                </Note>
              )}
              <Button title="Turn on" kind="secondary" busy={pushBusy} style={{ marginTop: 12 }}
                onPress={async () => { setPushBusy(true); await onEnableNotifications(); if (mounted.current) setPushBusy(false); }} />
            </>
          )}
      </Card>

      <Card>
        <Label>This phone</Label>
        <Text style={s.body}>
          The shop&apos;s figures are locked so only phones the shop PC approved can read them.
          To stop this phone seeing them, disconnect it here or remove it on the shop PC.
        </Text>
        {confirm ? (
          <>
            <Note tone="danger" style={{ marginTop: 12 }}>
              Disconnect? To connect again you will need to scan a new code at the shop PC.
            </Note>
            <Button title="Yes, disconnect" kind="danger" busy={busy}
              onPress={async () => { setBusy(true); await unlink(link); onDisconnected(''); }} />
            <Button title="Keep connected" kind="secondary" style={{ marginTop: 8 }} onPress={() => setConfirm(false)} />
          </>
        ) : (
          <Button title="Disconnect this phone" kind="danger" style={{ marginTop: 12 }} onPress={() => setConfirm(true)} />
        )}
      </Card>

      <Text style={{ textAlign: 'center', color: C.hint, fontSize: 12, marginTop: 8 }}>
        Curavo Owner · by ARZ Solutions
      </Text>
    </ScrollView>
  );
}
