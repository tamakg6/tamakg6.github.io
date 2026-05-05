const API_URL = "https://cha-t.tama-kg-6.workers.dev";
let currentUser      = JSON.parse(localStorage.getItem('chaT_user')) || null;
let currentChannelId = "general";
let lastRenderedKey  = {};
let lastSeenId = JSON.parse(localStorage.getItem('chaT_lastSeen') || '{}');
let isSignUp   = false;
let contacts   = currentUser
  ? (JSON.parse(localStorage.getItem(`chaT_contacts_${currentUser.user_id}`)) || [])
  : [];

let pushSubscription = null;

// ===========================
// 管理者ログパネル
// ===========================
function adminLog(msg, type = 'info') {
  if (type === 'error') console.error('[chaT]', msg);
  else console.log('[chaT]', msg);

  if (!currentUser || currentUser.user_id !== 'admin') return;
  const panel = document.getElementById('admin-log-panel');
  if (!panel) return;

  const line = document.createElement('div');
  line.className = `log-line log-${type}`;
  const time = new Date().toLocaleTimeString('ja-JP', { timeZone: 'Asia/Tokyo' });
  line.textContent = `[${time}] ${msg}`;
  panel.appendChild(line);
  while (panel.children.length > 50) panel.removeChild(panel.firstChild);
  panel.scrollTop = panel.scrollHeight;
}

function clearAdminLog() {
  const panel = document.getElementById('admin-log-panel');
  if (panel) panel.innerHTML = '';
}

function toggleLogPanel() {
  const wrap = document.getElementById('admin-log-wrap');
  if (!wrap) return;
  const isHidden = wrap.style.display === 'none' || wrap.style.display === '';
  wrap.style.display = isHidden ? 'flex' : 'none';
}

// ===========================
// サイドバー開閉
// ===========================
function toggleSidebar() { document.getElementById('app').classList.toggle('sidebar-open'); }

// ===========================
// 認証
// ===========================
function toggleAuthMode() {
  isSignUp = !isSignUp;
  document.getElementById('auth-title').textContent = isSignUp ? "chaT に新規登録" : "chaT にログイン";
  document.getElementById('auth-btn').textContent   = isSignUp ? "登録する" : "はじめる";
  document.getElementById('auth-displayname').style.display = isSignUp ? "block" : "none";
}

async function handleAuth() {
  const user_id      = document.getElementById('auth-userid').value.trim();
  const password     = document.getElementById('auth-password').value;
  const display_name = document.getElementById('auth-displayname').value.trim();
  if (!user_id || !password) return alert("入力してください");
  try {
    const res  = await fetch(`${API_URL}${isSignUp ? "/register" : "/login"}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_id, password, display_name }),
    });
    const data = await res.json();
    if (res.ok) {
      if (isSignUp) { alert("完了！ログインしてください"); toggleAuthMode(); }
      else {
        currentUser = data.user;
        localStorage.setItem('chaT_user', JSON.stringify(currentUser));
        contacts = JSON.parse(localStorage.getItem(`chaT_contacts_${currentUser.user_id}`)) || [];
        showApp();
      }
    } else { alert(data.error); }
  } catch (e) { alert("通信エラー"); }
}

// ===========================
// アプリ起動
// ===========================
function showApp() {
  document.getElementById('auth-overlay').style.display = "none";
  document.getElementById('app').style.display          = "flex";
  document.getElementById('user-display-name').textContent = currentUser.display_name;

  const uidLabel = document.getElementById('user-userid-label');
  if (uidLabel) uidLabel.textContent = `@${currentUser.user_id}`;

  if (currentUser.user_id === 'admin') {
    document.getElementById('admin-menu').style.display = 'block';
    document.getElementById('admin-log-wrap').style.display = 'flex';
    adminLog('管理者ログパネル起動');
  }

  // ★ iOSでは自動で許可を求めずSWだけ登録する
  setupPushSW();

  // すでに許可済みなら自動で購読を完了させる
  if (Notification.permission === 'granted') {
    completePushSubscription();
  } else {
    // 通知ボタンの状態を更新
    updatePushBtn();
  }

  renderUserList();
  setInterval(updatePolling, 3000);
  setInterval(pollBadges, 10000);
  selectChannel('general');

  const tx = document.getElementById('message-input');
  tx.addEventListener('input', () => {
    tx.style.height = 'auto';
    tx.style.height = tx.scrollHeight + 'px';
  });
  tx.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  });
}

// ===========================
// Service Worker 登録（許可は求めない）
// ===========================
async function setupPushSW() {
  if (!('serviceWorker' in navigator)) {
    adminLog('Service Worker非対応ブラウザ', 'warn');
    return;
  }
  try {
    const reg = await navigator.serviceWorker.register('./sw.js');
    await navigator.serviceWorker.ready;
    adminLog('SW準備完了 scope: ' + reg.scope);
  } catch (e) {
    adminLog('SW登録失敗: ' + e.message, 'error');
  }
}

// ===========================
// ★ ユーザーのタップで許可を求める（iOS対応）
// ===========================
async function enablePushManually() {
  adminLog('通知許可リクエスト開始（ユーザー操作）');

  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    adminLog('このブラウザはWeb Pushに非対応です', 'warn');
    alert("このブラウザは通知に対応していません。");
    return;
  }

  try {
    // ★ ユーザーのタップに応じて許可を求める（iOSの要件）
    const permission = await Notification.requestPermission();
    adminLog('通知許可状態: ' + permission, permission === 'granted' ? 'info' : 'warn');

    if (permission !== 'granted') {
      alert("通知が許可されませんでした。\niPadの「設定」→「chaT」→「通知」からオンにしてください。");
      return;
    }

    await completePushSubscription();
    alert("✅ 通知が有効になりました！");
    updatePushBtn();

  } catch (e) {
    adminLog('通知許可エラー: ' + e.message, 'error');
    alert("エラーが発生しました: " + e.message);
  }
}

// ===========================
// Push 購読を完了させる
// ===========================
async function completePushSubscription() {
  try {
    const reg = await navigator.serviceWorker.ready;

    // VAPID 公開鍵を取得
    const keyRes = await fetch(`${API_URL}/vapid-public-key`);
    const { publicKey } = await keyRes.json();
    adminLog('VAPID公開鍵: ' + (publicKey ? '取得OK (' + publicKey.slice(0, 20) + '...)' : '★取得失敗'), publicKey ? 'info' : 'error');
    if (!publicKey) return;

    // 購読
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      adminLog('新規Push購読を作成中...');
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey),
      });
      adminLog('新規購読作成完了');
    } else {
      adminLog('既存のPush購読を使用');
    }
    pushSubscription = sub;
    adminLog('エンドポイント: ' + sub.endpoint.slice(0, 50) + '...');

    // サーバーに登録
    const subRes = await fetch(`${API_URL}/subscribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        user_id: currentUser.user_id,
        subscription: sub.toJSON(),
      }),
    });
    adminLog('サーバー登録: ' + (subRes.ok ? '✅ 成功' : '★ 失敗 status=' + subRes.status), subRes.ok ? 'info' : 'error');

  } catch (e) {
    adminLog('Push購読エラー: ' + e.message, 'error');
  }
}

// 通知ボタンの表示を更新
function updatePushBtn() {
  const btn = document.getElementById('push-btn');
  if (!btn) return;
  if (Notification.permission === 'granted') {
    btn.textContent = '🔔 通知：有効';
    btn.style.color = '#5b8dee';
    btn.style.pointerEvents = 'none';
  } else if (Notification.permission === 'denied') {
    btn.textContent = '🔕 通知：ブロック中';
    btn.style.color = '#e05252';
    btn.style.pointerEvents = 'none';
  } else {
    btn.textContent = '🔔 通知を有効にする';
    btn.style.color = '';
    btn.style.pointerEvents = '';
  }
}

// base64url → Uint8Array
function urlBase64ToUint8Array(base64) {
  const pad = '='.repeat((4 - base64.length % 4) % 4);
  const b64 = (base64 + pad).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64);
  return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
}

// ===========================
// タブが裏にあるときの補助通知
// ===========================
function showInPageNotification(title, body) {
  if (Notification.permission !== 'granted' || !document.hidden) return;
  new Notification(title, { body, icon: '/favicon.ico', tag: 'chaT-tab', renotify: true });
}

// ===========================
// 未読バッジ
// ===========================
function getWatchedChannels() {
  const fixed = ['announcement', 'general'];
  const dms   = contacts.map(u => `dm_${[currentUser.user_id, u.user_id].sort().join('_')}`);
  return [...fixed, ...dms];
}

function updateChannelBadge(channelId, hasUnread) {
  const li = document.querySelector(`#sidebar li[data-id="${channelId}"]`);
  if (!li) return;
  li.querySelector('.badge')?.remove();
  if (hasUnread) {
    const dot = document.createElement('span');
    dot.className = 'badge';
    li.appendChild(dot);
  }
}

function markChannelRead(channelId, latestId) {
  if (!latestId) return;
  lastSeenId[channelId] = latestId;
  localStorage.setItem('chaT_lastSeen', JSON.stringify(lastSeenId));
  updateChannelBadge(channelId, false);
}

async function pollBadges() {
  const channels = getWatchedChannels();
  if (!channels.length) return;
  try {
    const userParam = currentUser.user_id === 'admin' ? '&user=admin' : '';
    const res = await fetch(`${API_URL}/channels/latest?channels=${channels.join(',')}${userParam}`);
    if (!res.ok) return;
    const latest = await res.json();

    const unread = [];
    channels.forEach(ch => {
      if (ch === currentChannelId) return;
      const hasUnread = (latest[ch] || 0) > (lastSeenId[ch] || 0);
      updateChannelBadge(ch, hasUnread);
      if (hasUnread) unread.push(ch);
    });

    if (unread.length > 0) {
      showInPageNotification('chaT — 新着メッセージ', `${unread.length}件のチャンネルに未読があります`);
    }
  } catch (_) {}
}

// ===========================
// メンテナンス
// ===========================
function checkMaintenance(status) {
  const overlay = document.getElementById('maintenance-overlay');
  if (status === 503 && currentUser?.user_id !== 'admin') {
    overlay.style.display = 'flex'; return true;
  }
  overlay.style.display = 'none'; return false;
}

async function toggleMaintenanceMode() {
  const choice = confirm("メンテナンスを【開始】しますか？\n（キャンセルで【解除】します）");
  const val = choice ? "true" : "false";
  try {
    const res = await fetch(`${API_URL}/admin/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'maintenance_mode', value: val, user_id: currentUser.user_id }),
    });
    if (res.ok) { alert(`メンテナンスを ${val === "true" ? 'ON' : 'OFF'} にしました。`); location.reload(); }
  } catch (_) { alert("Workersとの通信に失敗しました。"); }
}

// ===========================
// コンタクト / DM
// ===========================
async function addContact() {
  const targetId = document.getElementById('search-userid').value.trim();
  if (!targetId || targetId === currentUser.user_id) return;
  if (contacts.find(c => c.user_id === targetId)) return alert("すでに追加されています");
  try {
    const users = await (await fetch(`${API_URL}/users`)).json();
    const found = users.find(u => u.user_id === targetId);
    if (found) {
      contacts.push({ user_id: found.user_id, display_name: found.display_name });
      localStorage.setItem(`chaT_contacts_${currentUser.user_id}`, JSON.stringify(contacts));
      renderUserList();
      document.getElementById('search-userid').value = "";
    } else { alert("ユーザーが見つかりません"); }
  } catch (_) {}
}

function renderUserList() {
  const list = document.getElementById('user-list');
  list.innerHTML = contacts.map(u => {
    const dmId = `dm_${[currentUser.user_id, u.user_id].sort().join('_')}`;
    return `<li onclick="selectChannel('${dmId}')" data-id="${dmId}">👤 ${u.display_name}</li>`;
  }).join('');
}

// ===========================
// サイドバーのアクティブ表示
// ===========================
function updateActiveSidebarItem(channelId) {
  document.querySelectorAll('#sidebar li').forEach(el => {
    el.classList.toggle('active', el.dataset.id === channelId);
  });
}

// ===========================
// メッセージ読み込み
// ===========================
async function updatePolling() { await loadMessages(currentChannelId); }

function parseJST(str) {
  if (!str) return null;
  const d = new Date(str.replace(' ', 'T') + 'Z');
  return isNaN(d.getTime()) ? null : d;
}
function formatTime(d) {
  return d ? d.toLocaleTimeString('ja-JP', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit' }) : "";
}
function formatDate(d) {
  return d ? d.toLocaleDateString('ja-JP', { timeZone: 'Asia/Tokyo', year: 'numeric', month: 'long', day: 'numeric', weekday: 'short' }) : "";
}
function formatDateKey(d) {
  return d ? d.toLocaleDateString('ja-JP', { timeZone: 'Asia/Tokyo' }) : "";
}
function escapeHtml(str) {
  return str
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}

async function loadMessages(channelId) {
  try {
    const res = await fetch(`${API_URL}/messages?channel=${channelId}`);
    if (checkMaintenance(res.status)) return;

    const data = await res.json();
    const newKey = JSON.stringify(data.map(m => `${m.id}_${m.content}`));
    if (lastRenderedKey[channelId] === newKey) return;
    lastRenderedKey[channelId] = newKey;

    const msgDiv = document.getElementById('messages');
    if (channelId !== currentChannelId) return;

    const isBottom = msgDiv.scrollHeight - msgDiv.scrollTop <= msgDiv.clientHeight + 100;

    let lastDateKey = null;
    msgDiv.innerHTML = data.map(m => {
      const isMine    = m.sender_id === currentUser.user_id;
      const date      = parseJST(m.created_at);
      const timeStr   = formatTime(date);
      const dateKey   = formatDateKey(date);
      const canDel    = isMine || currentUser.user_id === 'admin';
      const delBtn    = canDel ? `<span class="delete-btn" onclick="deleteMessage(${m.id})" title="削除">×</span>` : "";
      const sideClass = isMine ? 'mine' : 'other';
      const header    = isMine
        ? delBtn
        : `<span class="msg-user">${m.display_name || m.sender_id}</span>${delBtn}`;

      let sep = '';
      if (dateKey && dateKey !== lastDateKey) {
        sep = `<div class="date-separator"><span>${formatDate(date)}</span></div>`;
        lastDateKey = dateKey;
      }

      return `${sep}<div class="msg-item ${sideClass}">
        <div class="msg-header">${header}</div>
        <div class="msg-content">${escapeHtml(m.content)}</div>
        <div class="msg-footer">${timeStr}</div>
      </div>`;
    }).join('');

    if (isBottom) msgDiv.scrollTop = msgDiv.scrollHeight;
    if (data.length > 0) markChannelRead(channelId, data[data.length - 1].id);

  } catch (_) {}
}

// ===========================
// メッセージ削除
// ===========================
async function deleteMessage(id) {
  if (!confirm("削除しますか？")) return;
  try {
    const res = await fetch(`${API_URL}/messages/${id}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_id: currentUser.user_id }),
    });
    if (res.ok) {
      lastRenderedKey[currentChannelId] = null;
      await loadMessages(currentChannelId);
    } else { alert("削除に失敗しました。"); }
  } catch (_) { alert("通信エラーが発生しました。"); }
}

// ===========================
// チャンネル選択
// ===========================
function selectChannel(id) {
  currentChannelId = id;
  const isAnnounce = id === 'announcement';
  document.getElementById('display-channel-name').textContent = isAnnounce ? "📢 お知らせ" : `# ${id}`;
  document.getElementById('input-area').style.display =
    (isAnnounce && currentUser.user_id !== 'admin') ? 'none' : 'flex';
  updateActiveSidebarItem(id);
  updateChannelBadge(id, false);
  if (window.innerWidth <= 768) document.getElementById('app').classList.remove('sidebar-open');
  lastRenderedKey[id] = null;
  loadMessages(id);
}

// ===========================
// メッセージ送信
// ===========================
async function sendMessage() {
  const input   = document.getElementById('message-input');
  const content = input.value.trim();
  if (!content) return;

  input.value = "";
  input.style.height = 'auto';

  try {
    const res = await fetch(`${API_URL}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel_id: currentChannelId, sender_id: currentUser.user_id, content }),
    });
    if (res.ok) {
      lastRenderedKey[currentChannelId] = null;
      await loadMessages(currentChannelId);
    } else if (res.status === 503) {
      alert("現在メンテナンス中のため送信できません。");
    } else {
      alert("送信に失敗しました。");
    }
  } catch (e) {
    console.error("Error:", e);
    alert("通信エラーが発生しました。");
  }
}

// ===========================
// ログアウト
// ===========================
async function logout() {
  if (pushSubscription) {
    try {
      await fetch(`${API_URL}/unsubscribe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ endpoint: pushSubscription.endpoint }),
      });
      await pushSubscription.unsubscribe();
    } catch (_) {}
  }
  localStorage.removeItem('chaT_user');
  location.reload();
}

window.onload = () => { if (currentUser) showApp(); };
