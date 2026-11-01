(() => {
  'use strict';

  const QUEUE_KEY = 'studentCloudSyncQueue';
  const ERROR_KEY = 'studentCloudSyncLastError';
  const DEVICE_KEY = 'studentCloudSyncDeviceId';
  const OWNER_KEY = 'studentCloudOwner';
  const DETACHED_OWNER_KEY = 'studentCloudDetachedOwner';
  const STORAGE_ENTITIES = {
    studentCourses: 'courses',
    studentReminders: 'reminders',
    studentBudgetTransactions: 'transactions',
    studentDiaryEntries: 'diary',
    studentMoodEntries: 'mood'
  };
  const ENTITY_STORAGE_KEYS = Object.fromEntries(
    Object.entries(STORAGE_ENTITIES).map(([key, entity]) => [entity, key])
  );
  const MAX_RETRY_MS = 5 * 60 * 1000;
  let client = null;
  let currentUser = null;
  let initialized = false;
  let remoteWriteDepth = 0;
  let realtimeChannel = null;
  let retryDelay = 5000;
  let retryTimer = null;
  let persistenceRequested = false;
  let startInProgress = false;
  let networkListenersInstalled = false;

  const statusElement = () => document.getElementById('cloudSyncStatus');
  const safetyElement = () => document.getElementById('cloudSafetyStatus');
  const messageElement = () => document.getElementById('cloudAccountMessage');

  function setStatus(message, state) {
    const element = statusElement();
    if (!element) return;
    element.textContent = message;
    element.dataset.state = state;
  }

  function setSafety(message, state) {
    const element = safetyElement();
    if (!element) return;
    element.textContent = message;
    element.dataset.state = state;
  }

  function setMessage(message) {
    const element = messageElement();
    if (element) element.textContent = message;
  }

  function recordSyncError(error) {
    const details = {
      occurred_at: new Date().toISOString(),
      message: error?.message || String(error)
    };
    try {
      Storage.prototype.setItem.call(localStorage, ERROR_KEY, JSON.stringify(details));
    } catch (storageError) {
      console.error('Could not persist the local sync error record', storageError);
    }
  }

  function scopedKey(key, userId) {
    return userId ? `${key}:${userId}` : key;
  }

  function activeOwnerId() {
    return currentUser?.id || localStorage.getItem(OWNER_KEY);
  }

  function readQueue() {
    try {
      const parsed = JSON.parse(localStorage.getItem(scopedKey(QUEUE_KEY, activeOwnerId())) || '[]');
      if (!Array.isArray(parsed)) throw new Error('Pending sync queue is not an array');
      return parsed;
    } catch (error) {
      console.error('Could not read the cloud sync queue', error);
      setStatus('🔴 同步失敗，無法讀取待同步佇列', 'error');
      throw error;
    }
  }

  function writeQueue(queue) {
    const originalSetItem = Storage.prototype.setItem;
    originalSetItem.call(localStorage, scopedKey(QUEUE_KEY, activeOwnerId()), JSON.stringify(queue));
  }

  function parseArray(raw) {
    try {
      const value = JSON.parse(raw || '[]');
      return Array.isArray(value) ? value : [];
    } catch (error) {
      console.error('Could not parse locally stored cloud data', error);
      setStatus('🔴 本機資料格式錯誤，請勿清除瀏覽器資料', 'error');
      return [];
    }
  }

  function taipeiDate() {
    const parts = new Intl.DateTimeFormat('en', {
      timeZone: 'Asia/Taipei',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).formatToParts(new Date());
    const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
    return `${values.year}-${values.month}-${values.day}`;
  }

  function parseCurrentValue(entity) {
    const storageKey = ENTITY_STORAGE_KEYS[entity];
    if (!storageKey) return null;
    const raw = localStorage.getItem(storageKey);
    const items = parseArray(raw);
    return items;
  }

  function findCurrentRecord(entity, recordId) {
    const items = parseCurrentValue(entity);
    return items?.find(item => String(item.id) === String(recordId)) || null;
  }

  function canonicalize(value) {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.keys(value).sort().map(key => [key, canonicalize(value[key])])
      );
    }
    return value;
  }

  async function fingerprintEntity(entity, items, userId) {
    const records = items.map(item => {
      const record = { ...item };
      delete record.created_at;
      delete record.updated_at;
      delete record.photo;
      if (entity === 'diary') {
        const path = item.photo_path || (item.photo ? `${userId}/${item.id}.jpg` : null);
        if (path) record.photo_path = path;
        else delete record.photo_path;
      }
      return canonicalize(record);
    }).sort((left, right) => String(left.id).localeCompare(String(right.id)));
    const bytes = new TextEncoder().encode(JSON.stringify(records));
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  }

  async function localFingerprints(userId) {
    const snapshot = getLocalSnapshot();
    return Object.fromEntries(await Promise.all(
      Object.entries(snapshot).map(async ([entity, items]) => [
        entity,
        await fingerprintEntity(entity, items, userId)
      ])
    ));
  }

  function enqueueChange(entity, record, isDeleted) {
    if (!activeOwnerId()) return;
    try {
      const queue = readQueue();
      const queueItem = {
        token: crypto.randomUUID(),
        entity,
        record_id: String(record.id),
        is_deleted: isDeleted,
        created_at: record.created_at || new Date().toISOString(),
        photo_path: record.photo_path || null,
        queued_at: new Date().toISOString()
      };
      const nextQueue = queue.filter(item =>
        item.entity !== entity || String(item.record_id) !== queueItem.record_id
      );
      nextQueue.push(queueItem);
      writeQueue(nextQueue);
      setStatus(
        navigator.onLine ? '🟡 同步中' : '🔴 同步失敗，等待網路恢復',
        navigator.onLine ? 'syncing' : 'error'
      );
      void drainQueue();
    } catch (error) {
      console.error('Could not persist a pending cloud sync operation', error);
      recordSyncError(error);
      setStatus('🔴 同步失敗，待同步紀錄無法保存', 'error');
    }
  }

  function installStorageObserver() {
    if (initialized) return;
    initialized = true;
    const originalSetItem = Storage.prototype.setItem;
    const originalRemoveItem = Storage.prototype.removeItem;

    Storage.prototype.setItem = function (key, value) {
      const oldValue = this.getItem(key);
      originalSetItem.call(this, key, value);
      if (this !== localStorage || remoteWriteDepth || !activeOwnerId() || !STORAGE_ENTITIES[key]) return;

      const entity = STORAGE_ENTITIES[key];
      const oldItems = parseArray(oldValue);
      const newItems = parseArray(value);
      const oldById = new Map(oldItems.filter(item => item && item.id != null).map(item => [String(item.id), item]));
      const normalized = newItems.map(item => {
        const id = item.id == null ? crypto.randomUUID() : item.id;
        const previous = oldById.get(String(id));
        if (previous && JSON.stringify(previous) === JSON.stringify(item)) return item;
        const timestamp = new Date().toISOString();
        return {
          ...item,
          id,
          created_at: item.created_at || previous?.created_at || timestamp,
          updated_at: timestamp
        };
      });

      if (JSON.stringify(normalized) !== JSON.stringify(newItems)) {
        originalSetItem.call(this, key, JSON.stringify(normalized));
      }

      const newIds = new Set(normalized.map(item => String(item.id)));
      const newById = new Map(normalized.map(item => [String(item.id), item]));
      oldItems.forEach(oldItem => {
        const recordId = String(oldItem.id);
        const changed = !newIds.has(recordId) ||
          JSON.stringify(oldItem) !== JSON.stringify(newById.get(recordId));
        if (changed) enqueueChange(entity, oldItem, !newIds.has(recordId));
      });
      normalized.forEach(item => {
        if (!oldById.has(String(item.id))) enqueueChange(entity, item, false);
      });
    };

    Storage.prototype.removeItem = function (key) {
      const oldValue = this.getItem(key);
      originalRemoveItem.call(this, key);
      if (this !== localStorage || remoteWriteDepth || !activeOwnerId() || !STORAGE_ENTITIES[key]) return;
      parseArray(oldValue).forEach(item => enqueueChange(STORAGE_ENTITIES[key], item, true));
    };
  }

  async function loadSdk() {
    if (window.supabase?.createClient) return;
    await new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2';
      script.async = true;
      script.onload = resolve;
      script.onerror = () => reject(new Error('無法載入 Supabase 用戶端程式庫'));
      document.head.appendChild(script);
    });
    if (!window.supabase?.createClient) throw new Error('Supabase 用戶端程式庫沒有正確載入');
  }

  function setAccountUi(user) {
    const signIn = document.getElementById('googleSignIn');
    const signOut = document.getElementById('googleSignOut');
    if (signIn) signIn.hidden = Boolean(user);
    if (signOut) signOut.hidden = !user;
    setMessage(user ? `已登入：${user.email || 'Google 帳號'}` : '登入後即可啟用跨裝置雲端同步。');
  }

  function getLocalSnapshot() {
    return Object.fromEntries(
      Object.entries(ENTITY_STORAGE_KEYS).map(([entity, key]) => [entity, parseArray(localStorage.getItem(key))])
    );
  }

  async function fetchCloudRecords() {
    const records = [];
    for (let from = 0; ; from += 500) {
      const { data, error } = await client
        .from('user_records')
        .select('entity, record_id, data, is_deleted, created_at, updated_at, deleted_at')
        .eq('user_id', currentUser.id)
        .range(from, from + 499);
      if (error) throw error;
      records.push(...data);
      if (data.length < 500) break;
    }
    return records;
  }

  function queuedRecordIds() {
    return new Set(readQueue().map(item => `${item.entity}:${item.record_id}`));
  }

  async function getRecordForCloud(entity, record) {
    const data = { ...record };
    if (entity === 'diary' && data.photo && !data.photo_path) {
      if (data.photo.startsWith('data:')) {
        const image = await fetch(data.photo).then(response => {
          if (!response.ok) throw new Error('日記照片讀取失敗');
          return response.blob();
        });
        const path = `${currentUser.id}/${record.id}.jpg`;
        const { error } = await client.storage.from('diary-photos').upload(path, image, {
          contentType: image.type || 'image/jpeg',
          upsert: true
        });
        if (error) throw error;
        data.photo_path = path;
        const signedUrl = await signedPhotoUrl(path);
        const snapshot = getLocalSnapshot();
        snapshot.diary = snapshot.diary.map(item => String(item.id) === String(record.id)
          ? { ...item, photo: signedUrl, photo_path: path }
          : item);
        if (typeof window.applyCloudSnapshot === 'function') {
          remoteWriteDepth += 1;
          try {
            window.applyCloudSnapshot(snapshot);
          } finally {
            remoteWriteDepth -= 1;
          }
        }
      } else {
        throw new Error('日記照片缺少雲端檔案路徑，請重新選取照片後儲存');
      }
    }
    delete data.photo;
    return data;
  }

  async function pushQueueItem(item) {
    const record = findCurrentRecord(item.entity, item.record_id);
    const data = item.is_deleted || !record
      ? (item.entity === 'diary' ? { photo_path: item.photo_path || `${currentUser.id}/${item.record_id}.jpg` } : {})
      : await getRecordForCloud(item.entity, record);
    const row = {
      user_id: currentUser.id,
      entity: item.entity,
      record_id: String(item.record_id),
      data,
      is_deleted: item.is_deleted || !record,
      created_at: item.created_at
    };
    const { error } = await client.from('user_records').upsert(row, {
      onConflict: 'user_id,entity,record_id'
    });
    if (error) throw error;
    if (row.is_deleted && item.entity === 'diary' && data.photo_path) {
      const { error: removeError } = await client.storage.from('diary-photos').remove([data.photo_path]);
      if (removeError) throw removeError;
    }
  }

  async function reportDeviceStatus() {
    if (!currentUser) return;
    const deviceStorageKey = scopedKey(DEVICE_KEY, currentUser.id);
    const deviceId = localStorage.getItem(deviceStorageKey) || crypto.randomUUID();
    localStorage.setItem(deviceStorageKey, deviceId);
    const pending = readQueue().length;
    const timestamp = new Date().toISOString();
    const localCounts = Object.fromEntries(
      Object.keys(ENTITY_STORAGE_KEYS).map(entity => [entity, parseCurrentValue(entity)?.length || 0])
    );
    const fingerprints = await localFingerprints(currentUser.id);
    const { error } = await client.from('user_sync_devices').upsert({
      user_id: currentUser.id,
      device_id: deviceId,
      pending_count: pending,
      local_counts: localCounts,
      local_fingerprints: fingerprints,
      last_seen_at: timestamp,
      last_reported_at: timestamp
    }, { onConflict: 'user_id,device_id' });
    if (error) throw error;
  }

  async function drainQueue() {
    if (!client || !currentUser || !navigator.onLine || drainQueue.running) return;
    drainQueue.running = true;
    try {
      let queue = readQueue();
      while (queue.length) {
        const item = queue[0];
        await pushQueueItem(item);
        queue = readQueue().filter(queued => queued.token !== item.token);
        writeQueue(queue);
      }
      await reportDeviceStatus();
      Storage.prototype.removeItem.call(localStorage, ERROR_KEY);
      retryDelay = 5000;
      if (!document.hidden) setStatus('🟢 已即時同步', 'synced');
      await refreshSafetyStatusSafely();
    } catch (error) {
      console.error('Cloud sync failed; the local pending queue is retained', error);
      recordSyncError(error);
      setStatus('🔴 同步失敗，正在重試', 'error');
      clearTimeout(retryTimer);
      retryTimer = setTimeout(() => void drainQueue(), retryDelay);
      retryDelay = Math.min(retryDelay * 2, MAX_RETRY_MS);
    } finally {
      drainQueue.running = false;
    }
  }

  function parseRemoteRecord(row) {
    return {
      entity: row.entity,
      id: row.record_id,
      is_deleted: row.is_deleted,
      created_at: row.created_at,
      updated_at: row.updated_at,
      data: row.data || {}
    };
  }

  async function signedPhotoUrl(path) {
    const { data, error } = await client.storage.from('diary-photos').createSignedUrl(path, 3600);
    if (error) throw error;
    return data.signedUrl;
  }

  async function mergeCloudRecords(records, pushLocal) {
    const snapshot = getLocalSnapshot();
    const cloudByKey = new Map(records.map(row => [`${row.entity}:${row.record_id}`, parseRemoteRecord(row)]));
    const pendingIds = queuedRecordIds();
    const merged = {};

    for (const entity of Object.keys(ENTITY_STORAGE_KEYS)) {
      const localById = new Map(snapshot[entity].filter(item => item && item.id != null)
        .map(item => [String(item.id), item]));
      const ids = new Set([
        ...localById.keys(),
        ...records.filter(row => row.entity === entity).map(row => String(row.record_id))
      ]);
      const items = [];

      for (const id of ids) {
        const local = localById.get(id);
        const remote = cloudByKey.get(`${entity}:${id}`);
        if (pendingIds.has(`${entity}:${id}`)) {
          if (local) items.push(local);
          continue;
        }
        const localTime = Date.parse(local?.updated_at || local?.created_at || '') || 0;
        const remoteTime = Date.parse(remote?.updated_at || '') || 0;
        if (remote && remote.is_deleted && remoteTime >= localTime) continue;

        if (local && (!remote || localTime > remoteTime)) {
          const timestamp = local.updated_at || local.created_at || new Date().toISOString();
          const normalized = {
            ...local,
            id,
            created_at: local.created_at || timestamp,
            updated_at: timestamp
          };
          items.push(normalized);
          if (pushLocal) enqueueChange(entity, normalized, false);
          continue;
        }

        if (remote && !remote.is_deleted) {
          const restored = { ...remote.data, id, created_at: remote.created_at, updated_at: remote.updated_at };
          if (entity === 'diary' && remote.data.photo_path) {
            restored.photo_path = remote.data.photo_path;
            restored.photo = await signedPhotoUrl(remote.data.photo_path);
          }
          items.push(restored);
        }
      }
      merged[entity] = items;
    }
    if (typeof window.applyCloudSnapshot === 'function') {
      remoteWriteDepth += 1;
      try {
        window.applyCloudSnapshot(merged);
      } finally {
        remoteWriteDepth -= 1;
      }
    }
  }

  async function refreshFromCloud() {
    const records = await fetchCloudRecords();
    await mergeCloudRecords(records, false);
  }

  async function refreshSafetyStatus() {
    if (!currentUser) return;
    const { data, error } = await client
      .from('user_daily_confirmations')
      .select('confirmed_on, status, record_count, synced_count, failed_count, checked_at')
      .eq('user_id', currentUser.id)
      .eq('confirmed_on', taipeiDate())
      .maybeSingle();
    if (error) throw error;
    if (!data) {
      setSafety('⏳ 今日 23:59 伺服器安全確認尚未執行', 'pending');
    } else if (data.status === 'completed') {
      setSafety('☁️ 今日 23:59 安全確認完成', 'complete');
    } else if (data.status === 'checking') {
      const checkAge = Date.now() - Date.parse(data.checked_at);
      if (Number.isFinite(checkAge) && checkAge > 10 * 60 * 1000) {
        setSafety('⚠️ 今日資料確認未完成（伺服器檢查逾時）', 'incomplete');
      } else {
        setSafety('⏳ 今日資料安全確認進行中', 'pending');
      }
    } else {
      setSafety(`⚠️ 今日資料確認未完成（${data.failed_count} 項待確認）`, 'incomplete');
    }
  }

  async function refreshSafetyStatusSafely() {
    try {
      await refreshSafetyStatus();
    } catch (error) {
      console.error('Could not load the daily safety confirmation status', error);
      setSafety('⚠️ 今日安全確認狀態載入失敗', 'incomplete');
    }
  }

  function saveAccountCache(userId) {
    const completeKey = `studentAccountCacheComplete:${userId}`;
    try {
      localStorage.removeItem(completeKey);
      const snapshot = getLocalSnapshot();
      Object.entries(snapshot).forEach(([entity, items]) => {
        const cachedItems = entity === 'diary'
          ? items.map(item => item.photo_path ? { ...item, photo: '' } : item)
          : items;
        localStorage.setItem(`studentAccountCache:${userId}:${entity}`, JSON.stringify(cachedItems));
      });
      localStorage.setItem(completeKey, 'true');
      return true;
    } catch (error) {
      console.error('Could not preserve the local account cache', error);
      setStatus('🔴 登出前無法安全保存本機快取；資料仍保留在此頁', 'error');
      setMessage('本機儲存空間不足，請先保持登入並同步資料後再切換帳號。');
      return false;
    }
  }

  function readAccountCache(userId) {
    return Object.fromEntries(
      Object.keys(ENTITY_STORAGE_KEYS).map(entity => [
        entity,
        parseArray(localStorage.getItem(`studentAccountCache:${userId}:${entity}`))
      ])
    );
  }

  function restoreAccountCache(userId) {
    const hasCache = localStorage.getItem(`studentAccountCacheComplete:${userId}`) === 'true';
    if (hasCache && typeof window.applyCloudSnapshot === 'function') {
      remoteWriteDepth += 1;
      try {
        window.applyCloudSnapshot(readAccountCache(userId));
      } finally {
        remoteWriteDepth -= 1;
      }
    }
  }

  function clearVisibleAccountData() {
    if (typeof window.applyCloudSnapshot !== 'function') return;
    remoteWriteDepth += 1;
    try {
      window.applyCloudSnapshot(Object.fromEntries(
        Object.keys(ENTITY_STORAGE_KEYS).map(entity => [entity, []])
      ));
    } finally {
      remoteWriteDepth -= 1;
    }
  }

  async function handleSignedIn(user) {
    const previousOwner = localStorage.getItem(OWNER_KEY);
    const detachedOwner = localStorage.getItem(DETACHED_OWNER_KEY);
    if (currentUser && currentUser.id !== user.id) {
      if (!saveAccountCache(currentUser.id)) return;
      clearVisibleAccountData();
      localStorage.setItem(DETACHED_OWNER_KEY, currentUser.id);
    } else if (!currentUser && previousOwner && previousOwner !== user.id && detachedOwner !== previousOwner) {
      if (!saveAccountCache(previousOwner)) return;
      clearVisibleAccountData();
      localStorage.setItem(DETACHED_OWNER_KEY, previousOwner);
    }
    if (currentUser?.id !== user.id) restoreAccountCache(user.id);
    localStorage.setItem(OWNER_KEY, user.id);
    localStorage.removeItem(DETACHED_OWNER_KEY);
    currentUser = user;
    setAccountUi(user);
    if (!persistenceRequested && navigator.storage?.persist) {
      persistenceRequested = true;
      void navigator.storage.persist().then(persisted => {
        if (!persisted) setMessage('瀏覽器未保證保留離線快取；請定期連線同步並避免清除網站資料。');
      }).catch(error => {
        console.warn('Could not request persistent browser storage', error);
      });
    }
    setStatus('🟡 正在載入雲端資料', 'syncing');
    try {
      const records = await fetchCloudRecords();
      await mergeCloudRecords(records, true);
      await drainQueue();
      if (realtimeChannel) await client.removeChannel(realtimeChannel);
      realtimeChannel = client
        .channel(`user-records-${user.id}`)
        .on('postgres_changes', {
          event: '*',
          schema: 'public',
          table: 'user_records',
          filter: `user_id=eq.${user.id}`
        }, () => {
          void refreshFromCloud().catch(error => {
            console.error('Could not refresh data after a cloud update', error);
            setStatus('🔴 雲端更新載入失敗，請重新整理', 'error');
          });
        })
        .subscribe();
      await refreshSafetyStatusSafely();
    } catch (error) {
      console.error('Cloud startup failed', error);
      setStatus('🔴 雲端連線失敗，正在保留本機資料並重試', 'error');
      setMessage(`雲端載入失敗：${error.message || '未知錯誤'}`);
      clearTimeout(retryTimer);
      retryTimer = setTimeout(() => void handleSignedIn(user), retryDelay);
    }
  }

  async function start() {
    installStorageObserver();
    if (!networkListenersInstalled) {
      networkListenersInstalled = true;
      window.addEventListener('online', () => {
        if (client) void drainQueue();
        else void start();
      });
      window.addEventListener('offline', () => {
        if (activeOwnerId()) setStatus('🔴 同步失敗，等待網路恢復', 'error');
      });
      document.addEventListener('visibilitychange', () => {
        if (!document.hidden && client) void drainQueue();
      });
    }
    if (startInProgress) return;
    const config = window.SUPABASE_CONFIG || {};
    if (!config.url || !config.anonKey) {
      setStatus('⚪ 尚未設定雲端服務；目前資料僅保存在此裝置', 'local');
      setSafety('⚪ 請先完成 Supabase 部署設定', 'local');
      setAccountUi(null);
      const signIn = document.getElementById('googleSignIn');
      if (signIn) signIn.disabled = true;
      return;
    }

    startInProgress = true;
    try {
      setStatus('🟡 正在連線雲端', 'syncing');
      await loadSdk();
      client = window.supabase.createClient(config.url, config.anonKey, {
        auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
      });
      const { data, error } = await client.auth.getSession();
      if (error) throw error;
      if (data.session?.user) await handleSignedIn(data.session.user);
      else {
        setAccountUi(null);
        setStatus('⚪ 尚未登入；資料仍保存在此裝置', 'local');
        setSafety('⚪ 登入後啟用雲端安全確認', 'local');
      }
      client.auth.onAuthStateChange((_event, session) => {
        if (session?.user) {
          void handleSignedIn(session.user);
        } else {
          const ownerId = currentUser?.id;
          const cacheSaved = ownerId ? saveAccountCache(ownerId) : true;
          currentUser = null;
          setAccountUi(null);
          if (cacheSaved) {
            clearVisibleAccountData();
            if (ownerId) localStorage.setItem(DETACHED_OWNER_KEY, ownerId);
            localStorage.removeItem(OWNER_KEY);
            setStatus('⚪ 尚未登入；資料仍保存在此裝置', 'local');
          }
          setSafety('⚪ 登入後啟用雲端安全確認', 'local');
        }
      });
      setInterval(() => {
        if (currentUser && !document.hidden) {
          void reportDeviceStatus().then(refreshSafetyStatusSafely).catch(error => {
            console.error('Could not report device sync status', error);
            setStatus('🔴 同步失敗，正在重試', 'error');
          });
        }
      }, 60 * 1000);
    } catch (error) {
      console.error('Supabase initialization failed', error);
      setStatus('🔴 雲端服務初始化失敗', 'error');
      setMessage(error.message || '請檢查 Supabase 設定。');
    } finally {
      startInProgress = false;
    }
  }

  async function signInWithGoogle() {
    if (!client) {
      setMessage('請先完成 Supabase 網址與公開 anon key 設定。');
      return;
    }
    try {
      const { error } = await client.auth.signInWithOAuth({
        provider: 'google',
        options: { redirectTo: window.location.href }
      });
      if (error) throw error;
    } catch (error) {
      console.error('Google sign-in failed', error);
      setMessage(`Google 登入失敗：${error.message || '請稍後再試。'}`);
    }
  }

  async function signOut() {
    if (!client) return;
    try {
      const { error } = await client.auth.signOut();
      if (error) throw error;
    } catch (error) {
      console.error('Sign-out failed', error);
      setMessage(`登出失敗：${error.message || '請稍後再試。'}`);
    }
  }

  window.cloudSync = {
    start,
    signInWithGoogle,
    signOut,
    withRemoteWrite(callback) {
      remoteWriteDepth += 1;
      try {
        callback();
      } finally {
        remoteWriteDepth -= 1;
      }
    },
    get user() {
      return currentUser;
    }
  };
})();
