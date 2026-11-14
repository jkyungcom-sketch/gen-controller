/* ble-native-adapter.js — Capacitor BLE (BluetoothLe) <-> Web Bluetooth API 완벽 호환 어댑터 (V5)
 * [핵심 수리 내역]
 * 1. 필터 완전 해제: 앱 인벤터처럼 주변의 모든 블루투스 기기를 누락 없이 목록에 표시 (korea 발전기는 목록 최상단 우선 배치)
 * 2. 폰 기본 설정(블루투스) 미등록 기기 완벽 지원: rawAdvertisement(AD Type 0x08/0x09)에서 실제 기기 이름 직접 추출
 * 3. 앱 최초 실행 시 권한 팝업 대기 중 initialize 실패가 영구 캐시되던 버그 수정 (매 호출 시 안전한 재초기화 보장)
 * 4. 최고 감도 스캔(scanMode: 2, LOW_LATENCY) 적용으로 [연결하기] 터치 즉시 검색
 */
(function () {
  "use strict";

  var isCapAndroid = !!(
    (window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform()) ||
    (window.Capacitor && window.Capacitor.getPlatform && window.Capacitor.getPlatform() === "android") ||
    /; wv\)/.test(navigator.userAgent || "")
  );
  if (!isCapAndroid) {
    return; // 일반 PC/모바일 크롬 브라우저에서는 기본 Web Bluetooth 사용
  }

  var SERVICE_UUID = "12345678-1234-1234-1234-1234567890ab";
  var CHAR_UUID    = "abcdefab-1234-5678-1234-abcdefabcdef";
  var LS_DEV_ID    = "ble_native_device_id";
  var LS_DEV_NAME  = "ble_native_device_name";

  var _blePluginPromise = null;
  var _bleInitialized = false;

  function getBlePlugin() {
    if (_blePluginPromise) return _blePluginPromise;
    _blePluginPromise = new Promise(function (resolve, reject) {
      var t0 = Date.now();
      (function poll() {
        var p = window.Capacitor && window.Capacitor.Plugins;
        var BLE = p && p.BluetoothLe;
        if (BLE) {
          return resolve(BLE);
        }
        if (Date.now() - t0 > 10000) {
          _blePluginPromise = null;
          return reject(new Error("BluetoothLe 플러그인 로드 시간 초과"));
        }
        setTimeout(poll, 60);
      })();
    });
    return _blePluginPromise;
  }

  function getReadyBle() {
    return getBlePlugin().then(function (BLE) {
      if (_bleInitialized) return BLE;
      return BLE.initialize({ androidNeverForLocation: true })
        .catch(function () {
          return BLE.initialize();
        })
        .then(function () {
          _bleInitialized = true;
          return BLE;
        })
        .catch(function (err) {
          // 아직 런타임 권한 팝업 승인 전일 수 있으므로 _bleInitialized를 false로 유지해 다음번 클릭 시 재시도
          _bleInitialized = false;
          console.warn("[ble-adapter] BLE.initialize 재시도 대기:", err);
          return BLE;
        });
    });
  }

  function isKoreaName(name) {
    if (!name) return false;
    return String(name).trim().toLowerCase().indexOf("korea") === 0;
  }

  // ★ 폰 기본 설정에 등록하지 않은 새 발전기도 전파 패킷 원본(rawAdvertisement)에서 이름을 100% 추출
  function extractNameFromRawAdv(rawHex) {
    if (!rawHex || typeof rawHex !== "string") return "";
    var clean = rawHex.replace(/[^0-9a-fA-F]/g, "");
    if (clean.length < 4 || clean.length % 2 !== 0) return "";
    var bytes = new Uint8Array(clean.length / 2);
    for (var i = 0; i < bytes.length; i++) {
      bytes[i] = parseInt(clean.substring(i * 2, i * 2 + 2), 16);
    }
    var idx = 0;
    var bestName = "";
    while (idx < bytes.length) {
      var len = bytes[idx];
      if (!len || idx + len >= bytes.length) break;
      var adType = bytes[idx + 1];
      // 0x08 = Shortened Local Name, 0x09 = Complete Local Name
      if ((adType === 0x08 || adType === 0x09) && len > 1) {
        try {
          var sub = bytes.subarray(idx + 2, idx + 1 + len);
          var decoded = new TextDecoder("utf-8").decode(sub).replace(/\0/g, "").trim();
          if (decoded) {
            if (adType === 0x09 || !bestName) {
              bestName = decoded;
            }
          }
        } catch (e) {}
      }
      idx += len + 1;
    }
    return bestName;
  }

  function getSavedId() {
    try {
      return localStorage.getItem(LS_DEV_ID) || localStorage.getItem("ble_last_id") || "";
    } catch (e) { return ""; }
  }

  function getSavedName() {
    try {
      return localStorage.getItem(LS_DEV_NAME) || localStorage.getItem("ble_last_name") || "";
    } catch (e) { return ""; }
  }

  function saveDeviceIdentity(id, name) {
    try {
      if (id) {
        localStorage.setItem(LS_DEV_ID, id);
        localStorage.setItem("ble_last_id", id);
      }
      if (name) {
        localStorage.setItem(LS_DEV_NAME, name);
        localStorage.setItem("ble_last_name", name);
      }
    } catch (e) {}
  }

  function bytesToHex(u8) {
    var out = "";
    for (var i = 0; i < u8.length; i++) {
      var h = u8[i].toString(16);
      out += (h.length === 1 ? "0" + h : h);
    }
    return out;
  }

  function toHexFromBufferSource(data) {
    var u8;
    if (data instanceof Uint8Array) {
      u8 = data;
    } else if (ArrayBuffer.isView(data)) {
      u8 = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    } else if (data instanceof ArrayBuffer) {
      u8 = new Uint8Array(data);
    } else if (typeof data === "string") {
      u8 = new TextEncoder().encode(data);
    } else {
      u8 = new Uint8Array(0);
    }
    return bytesToHex(u8);
  }

  function parseNotifyDataView(rawVal) {
    if (!rawVal) return new DataView(new ArrayBuffer(0));
    if (rawVal instanceof DataView) return rawVal;
    if (ArrayBuffer.isView(rawVal)) {
      return new DataView(rawVal.buffer, rawVal.byteOffset, rawVal.byteLength);
    }
    if (typeof rawVal === "string") {
      var s = rawVal.trim();
      if (/^[0-9a-fA-F]+$/.test(s) && s.length % 2 === 0) {
        var bytes = new Uint8Array(s.length / 2);
        for (var i = 0; i < s.length; i += 2) {
          bytes[i / 2] = parseInt(s.substring(i, i + 2), 16);
        }
        return new DataView(bytes.buffer);
      }
      var hexParts = s.split(" ");
      var allHex = hexParts.length > 0 && hexParts.every(function (p) { return /^[0-9a-fA-F]{1,2}$/.test(p); });
      if (allHex) {
        var b2 = new Uint8Array(hexParts.length);
        for (var j = 0; j < hexParts.length; j++) {
          b2[j] = parseInt(hexParts[j], 16);
        }
        return new DataView(b2.buffer);
      }
      var enc = new TextEncoder().encode(rawVal);
      return new DataView(enc.buffer);
    }
    return new DataView(new ArrayBuffer(0));
  }

  function normalizeUuid(u) {
    if (!u) return SERVICE_UUID;
    if (typeof u === "number") {
      var hex = u.toString(16).padStart(4, "0");
      return "0000" + hex + "-0000-1000-8000-00805f9b34fb";
    }
    var s = String(u).toLowerCase();
    if (s.length === 4) return "0000" + s + "-0000-1000-8000-00805f9b34fb";
    return s;
  }

  function BleCharacteristic(deviceId, serviceUuid, charUuid) {
    this.uuid = charUuid;
    this.value = null;
    this._deviceId = deviceId;
    this._serviceUuid = serviceUuid;
    this._listeners = {};
    this._capHandle = null;
  }
  BleCharacteristic.prototype.addEventListener = function (type, fn) {
    if (!this._listeners[type]) this._listeners[type] = [];
    if (this._listeners[type].indexOf(fn) === -1) {
      this._listeners[type].push(fn);
    }
  };
  BleCharacteristic.prototype.removeEventListener = function (type, fn) {
    var arr = this._listeners[type] || [];
    var idx = arr.indexOf(fn);
    if (idx >= 0) arr.splice(idx, 1);
  };
  BleCharacteristic.prototype._emitValue = function (dv) {
    this.value = dv;
    var evt = { target: { value: dv }, currentTarget: this };
    if (typeof this.oncharacteristicvaluechanged === "function") {
      try { this.oncharacteristicvaluechanged(evt); } catch (e) { console.error(e); }
    }
    var arr = (this._listeners["characteristicvaluechanged"] || []).slice();
    for (var i = 0; i < arr.length; i++) {
      try { arr[i](evt); } catch (e) { console.error(e); }
    }
  };
  BleCharacteristic.prototype.startNotifications = function () {
    var self = this;
    var eventKey = "notification|" + self._deviceId + "|" + self._serviceUuid + "|" + self.uuid;
    return getReadyBle().then(function (BLE) {
      var p = Promise.resolve();
      if (self._capHandle && typeof self._capHandle.remove === "function") {
        p = self._capHandle.remove().catch(function () {});
        self._capHandle = null;
      }
      return p.then(function () {
        return BLE.addListener(eventKey, function (event) {
          var raw = event && event.value !== undefined ? event.value : event;
          var dv = parseNotifyDataView(raw);
          self._emitValue(dv);
        });
      }).then(function (handle) {
        self._capHandle = handle;
        return BLE.startNotifications({
          deviceId: self._deviceId,
          service: self._serviceUuid,
          characteristic: self.uuid
        });
      }).then(function () {
        return self;
      });
    });
  };
  BleCharacteristic.prototype.stopNotifications = function () {
    var self = this;
    return getReadyBle().then(function (BLE) {
      return BLE.stopNotifications({
        deviceId: self._deviceId,
        service: self._serviceUuid,
        characteristic: self.uuid
      }).catch(function () {});
    }).then(function () {
      if (self._capHandle && typeof self._capHandle.remove === "function") {
        self._capHandle.remove().catch(function () {});
        self._capHandle = null;
      }
    });
  };
  BleCharacteristic.prototype.writeValue = function (data) {
    var self = this;
    var hex = toHexFromBufferSource(data);
    return getReadyBle().then(function (BLE) {
      return BLE.write({
        deviceId: self._deviceId,
        service: self._serviceUuid,
        characteristic: self.uuid,
        value: hex
      });
    });
  };
  BleCharacteristic.prototype.writeValueWithResponse = BleCharacteristic.prototype.writeValue;
  BleCharacteristic.prototype.writeValueWithoutResponse = function (data) {
    var self = this;
    var hex = toHexFromBufferSource(data);
    return getReadyBle().then(function (BLE) {
      var fn = BLE.writeWithoutResponse || BLE.write;
      return fn.call(BLE, {
        deviceId: self._deviceId,
        service: self._serviceUuid,
        characteristic: self.uuid,
        value: hex
      });
    });
  };

  function BleService(deviceId, serviceUuid) {
    this.uuid = serviceUuid;
    this._deviceId = deviceId;
    this._chars = {};
  }
  BleService.prototype.getCharacteristic = function (charUuid) {
    var cu = normalizeUuid(charUuid || CHAR_UUID);
    if (!this._chars[cu]) {
      this._chars[cu] = new BleCharacteristic(this._deviceId, this.uuid, cu);
    }
    return Promise.resolve(this._chars[cu]);
  };

  var _activeDevices = {};

  function BleDevice(devId, devName) {
    var self = this;
    this.id = devId;
    this.name = devName || "korea0000";
    this._listeners = {};
    this._discHandle = null;
    _activeDevices[devId] = this;
    this.gatt = {
      connected: false,
      device: self,
      connect: function () {
        return getReadyBle().then(function (BLE) {
          var p = Promise.resolve();
          if (self._discHandle && typeof self._discHandle.remove === "function") {
            p = self._discHandle.remove().catch(function () {});
            self._discHandle = null;
          }
          return p.then(function () {
            return BLE.connect({ deviceId: self.id }).catch(function () {
              return BLE.disconnect({ deviceId: self.id }).catch(function () {})
                .then(function () { return new Promise(function (r) { setTimeout(r, 250); }); })
                .then(function () { return BLE.connect({ deviceId: self.id }); });
            });
          }).then(function () {
            self.gatt.connected = true;
            saveDeviceIdentity(self.id, self.name);
            return BLE.addListener("disconnected|" + self.id, function () {
              self.gatt.connected = false;
              self._emit("gattserverdisconnected", { target: self });
            });
          }).then(function (h) {
            self._discHandle = h;
            return self.gatt;
          });
        });
      },
      disconnect: function () {
        self.gatt.connected = false;
        var p = Promise.resolve();
        if (self._discHandle && typeof self._discHandle.remove === "function") {
          p = self._discHandle.remove().catch(function () {});
          self._discHandle = null;
        }
        p.then(function () { return getReadyBle(); })
          .then(function (BLE) { return BLE.disconnect({ deviceId: self.id }); })
          .catch(function () {});
      },
      getPrimaryService: function (svcUuid) {
        var su = normalizeUuid(svcUuid || SERVICE_UUID);
        return Promise.resolve(new BleService(self.id, su));
      }
    };
  }
  BleDevice.prototype.addEventListener = function (type, fn) {
    if (!this._listeners[type]) this._listeners[type] = [];
    if (this._listeners[type].indexOf(fn) === -1) {
      this._listeners[type].push(fn);
    }
  };
  BleDevice.prototype.removeEventListener = function (type, fn) {
    var arr = this._listeners[type] || [];
    var idx = arr.indexOf(fn);
    if (idx >= 0) arr.splice(idx, 1);
  };
  BleDevice.prototype._emit = function (type, evt) {
    var arr = (this._listeners[type] || []).slice();
    for (var i = 0; i < arr.length; i++) {
      try { arr[i](evt); } catch (e) { console.error(e); }
    }
  };

  var _cachedDevice = null;

  // 완전 초기화용 헬퍼 (연결 해제 + 캐시 제거)
  window.__bleNativeReset = function () {
    var lastId = getSavedId();
    _cachedDevice = null;
    return getReadyBle().then(function (BLE) {
      var ids = Object.keys(_activeDevices);
      if (lastId && ids.indexOf(lastId) === -1) ids.push(lastId);
      return Promise.all(ids.map(function (id) {
        return BLE.disconnect({ deviceId: id }).catch(function () {});
      }));
    }).catch(function () {});
  };

  // 블루투스 기기 선택 모달창 (앱 인벤터 방식: 필터 없이 주변 모든 블루투스 표시 + korea 기기 최상단 정렬)
  function openKoreaDevicePickerModal(BLE) {
    return new Promise(function (resolve, reject) {
      var old = document.getElementById("__koreaBlePickerModal");
      if (old && old.parentNode) old.parentNode.removeChild(old);

      var overlay = document.createElement("div");
      overlay.id = "__koreaBlePickerModal";
      overlay.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,0.82);display:flex;align-items:center;justify-content:center;z-index:99999;padding:18px;";

      var box = document.createElement("div");
      box.style.cssText = "width:100%;max-width:360px;background:#162033;border:1px solid #3b82f6;border-radius:18px;padding:18px;color:#f8fafc;font-family:inherit;box-shadow:0 12px 32px rgba(0,0,0,0.5);";

      var title = document.createElement("div");
      title.style.cssText = "font-size:17px;font-weight:800;margin-bottom:6px;display:flex;align-items:center;justify-content:space-between;";
      title.innerHTML = '<span>📡 블루투스 기기 선택</span><span id="__bleScanStat" style="font-size:12px;color:#38bdf8;font-weight:700;">스캔 중...</span>';

      var sub = document.createElement("div");
      sub.style.cssText = "font-size:12.5px;color:#94a3b8;margin-bottom:12px;line-height:1.4;";
      sub.textContent = "목록에서 연결할 발전기(korea...)를 터치하면 비밀번호 4자리 입력창이 열립니다.";

      var listWrap = document.createElement("div");
      listWrap.style.cssText = "display:flex;flex-direction:column;gap:8px;max-height:280px;overflow-y:auto;margin-bottom:14px;padding:4px 0;";

      var emptyMsg = document.createElement("div");
      emptyMsg.style.cssText = "text-align:center;padding:24px 10px;color:#cbd5e1;font-size:13.5px;background:#0b1120;border-radius:12px;border:1px dashed #334155;";
      emptyMsg.innerHTML = "🔍 주변 블루투스 기기를 찾고 있습니다...<br><span style='font-size:11.5px;color:#64748b'>(발전기 전원이 켜져 있는지 확인하세요)</span>";
      listWrap.appendChild(emptyMsg);

      var btnRow = document.createElement("div");
      btnRow.style.cssText = "display:flex;gap:8px;";

      var btnRescan = document.createElement("button");
      btnRescan.type = "button";
      btnRescan.style.cssText = "flex:1;padding:12px;border-radius:10px;border:1px solid #334155;background:#1e293b;color:#e2e8f0;font-size:14px;font-weight:700;cursor:pointer;";
      btnRescan.textContent = "🔄 다시 검색";

      var btnCancel = document.createElement("button");
      btnCancel.type = "button";
      btnCancel.style.cssText = "flex:1;padding:12px;border-radius:10px;border:none;background:#334155;color:#fff;font-size:14px;font-weight:700;cursor:pointer;";
      btnCancel.textContent = "닫기";

      btnRow.appendChild(btnRescan);
      btnRow.appendChild(btnCancel);

      box.appendChild(title);
      box.appendChild(sub);
      box.appendChild(listWrap);
      box.appendChild(btnRow);
      overlay.appendChild(box);
      document.body.appendChild(overlay);

      var foundMap = {};
      var scanHandle = null;
      var scanTimer = null;
      var closed = false;
      var currentSavedId = getSavedId();

      function stopScanningAsync() {
        if (scanTimer) {
          clearTimeout(scanTimer);
          scanTimer = null;
        }
        var statEl = document.getElementById("__bleScanStat");
        if (statEl) statEl.textContent = "탐색 완료";
        var h = scanHandle;
        scanHandle = null;
        return Promise.resolve()
          .then(function () {
            if (typeof BLE.stopLEScan === "function") {
              return BLE.stopLEScan().catch(function () {});
            }
          })
          .then(function () {
            if (h && typeof h.remove === "function") {
              return h.remove().catch(function () {});
            }
          });
      }

      function addCandidate(id, name, sourceLabel, isPriorityGen) {
        if (closed || !id) return;
        var cleanNm = String(name || "").trim();
        var isGen = !!(isPriorityGen || isKoreaName(cleanNm));

        if (foundMap[id]) {
          // 나중에 도착한 스캔 패킷에서 진짜 이름(예: korea1234)이 확인되면 즉시 화면 업데이트!
          if (cleanNm && (!foundMap[id].name || foundMap[id].name === id || foundMap[id].name === "이름 없는 기기")) {
            foundMap[id].name = cleanNm;
            foundMap[id].btnNameEl.textContent = (isGen ? "⚡ " : "🔹 ") + cleanNm;
            if (isGen && foundMap[id].itemBtn && listWrap.firstChild !== foundMap[id].itemBtn) {
              listWrap.insertBefore(foundMap[id].itemBtn, listWrap.firstChild);
            }
          }
          return;
        }
        if (emptyMsg && emptyMsg.parentNode === listWrap) {
          listWrap.removeChild(emptyMsg);
        }

        var displayNm = cleanNm || id;
        var itemBtn = document.createElement("button");
        itemBtn.type = "button";
        var isCurrent = (currentSavedId && currentSavedId === id);
        var borderColor = isCurrent ? "#10b981" : (isGen ? "#3b82f6" : "#334155");
        var bgColor = isCurrent ? "rgba(16,185,129,0.15)" : (isGen ? "#0f1d36" : "#0b1120");
        itemBtn.style.cssText = "width:100%;padding:14px;border-radius:12px;border:1px solid " + borderColor + ";background:" + bgColor + ";color:#f8fafc;display:flex;align-items:center;justify-content:space-between;cursor:pointer;text-align:left;";

        var leftDiv = document.createElement("div");
        var nameEl = document.createElement("div");
        nameEl.style.cssText = "font-size:15.5px;font-weight:800;color:#fff;";
        nameEl.textContent = (isGen ? "⚡ " : "🔹 ") + displayNm;

        var metaEl = document.createElement("div");
        metaEl.style.cssText = "font-size:11.5px;color:#94a3b8;margin-top:3px;";
        metaEl.textContent = sourceLabel + " · " + id + (isCurrent ? " (최근 연결)" : "");

        leftDiv.appendChild(nameEl);
        leftDiv.appendChild(metaEl);

        var rightBadge = document.createElement("span");
        rightBadge.style.cssText = "padding:6px 12px;border-radius:8px;background:#2563eb;color:#fff;font-size:13px;font-weight:800;white-space:nowrap;";
        rightBadge.textContent = "선택";

        itemBtn.appendChild(leftDiv);
        itemBtn.appendChild(rightBadge);

        itemBtn.addEventListener("click", function () {
          if (closed) return;
          closed = true;
          var chosenName = (foundMap[id] && foundMap[id].name) ? foundMap[id].name : (cleanNm || "korea0000");
          if (overlay && overlay.parentNode) {
            overlay.parentNode.removeChild(overlay);
          }
          // 스캔을 완전히 멈춘 뒤 120ms 후 dev 반환 -> 즉시 비밀번호 입력창(askPinModal) 표시!
          stopScanningAsync().then(function () {
            return new Promise(function (r) { setTimeout(r, 120); });
          }).then(function () {
            var dev = new BleDevice(id, chosenName);
            _cachedDevice = dev;
            resolve(dev);
          });
        });

        foundMap[id] = { id: id, name: cleanNm, btnNameEl: nameEl, itemBtn: itemBtn };
        // 발전기(korea...) 또는 최근 연결 기기는 무조건 맨 위에 배치, 나머지는 아래에 추가
        if ((isGen || isCurrent) && listWrap.firstChild) {
          listWrap.insertBefore(itemBtn, listWrap.firstChild);
        } else {
          listWrap.appendChild(itemBtn);
        }
      }

      function startDiscovery() {
        var statEl = document.getElementById("__bleScanStat");
        if (statEl) statEl.textContent = "주변 스캔 중...";

        // 0) 권한 및 BLE 초기화 재확인
        BLE.initialize({ androidNeverForLocation: true }).catch(function () {
          return BLE.initialize().catch(function () {});
        }).then(function () {
          _bleInitialized = true;

          // 1) 폰에 이미 연결/등록된 기기도 필터 없이 모두 조회
          var pConn = (typeof BLE.getConnectedDevices === "function")
            ? BLE.getConnectedDevices({ services: [SERVICE_UUID] }).catch(function () { return { devices: [] }; })
            : Promise.resolve({ devices: [] });
          var pBond = (typeof BLE.getBondedDevices === "function")
            ? BLE.getBondedDevices().catch(function () { return { devices: [] }; })
            : Promise.resolve({ devices: [] });

          Promise.all([pConn, pBond]).then(function (res) {
            var l1 = (res[0] && res[0].devices) || [];
            var l2 = (res[1] && res[1].devices) || [];
            var all = l1.concat(l2);
            for (var i = 0; i < all.length; i++) {
              var d = all[i];
              var id = d && (d.deviceId || d.id);
              var nm = (d && d.name) || "";
              if (id) {
                addCandidate(id, nm, "등록된 기기", isKoreaName(nm));
              }
            }
          });

          // 2) ★ 주변 실시간 BLE 스캔 (필터 없이 모든 블루투스 표시 + rawAdvertisement에서 이름 추출 + scanMode:2 최고감도)
          if (typeof BLE.requestLEScan === "function") {
            stopScanningAsync().then(function () {
              if (closed) return;
              var sEl = document.getElementById("__bleScanStat");
              if (sEl) sEl.textContent = "주변 스캔 중...";
              return BLE.addListener("onScanResult", function (res) {
                if (closed || !res) return;
                var d = res.device || res;
                var id = d.deviceId || d.id;
                if (!id) return;
                var rawAdvName = extractNameFromRawAdv(res.rawAdvertisement);
                var nm = d.name || res.localName || rawAdvName || "";
                var uuids = res.uuids || [];
                var hasGenUuid = Array.isArray(uuids) && uuids.some(function (u) {
                  var lu = String(u).toLowerCase();
                  return lu.indexOf("12345678") >= 0 || lu.indexOf("ffe0") >= 0;
                });
                // 이름 없는 주변 잡신호(TV/워치 MAC만 수십 개 뜨는 현상)보다 이름이 있거나 발전기 UUID가 있는 기기를 우선 표시하되,
                // 이름이 있거나 발전기 UUID가 있으면 100% 필터 없이 전부 표시!
                if (nm || hasGenUuid) {
                  addCandidate(id, nm || "korea0000", "실시간 검색", isKoreaName(nm) || hasGenUuid);
                }
              });
            }).then(function (h) {
              if (closed) {
                if (h && h.remove) h.remove().catch(function () {});
                return;
              }
              scanHandle = h;
              return BLE.requestLEScan({ allowDuplicates: true, scanMode: 2 });
            }).then(function () {
              if (closed) return;
              scanTimer = setTimeout(function () {
                stopScanningAsync();
              }, 10000);
            }).catch(function () {
              stopScanningAsync();
            });
          }
        });
      }

      btnRescan.addEventListener("click", function () {
        startDiscovery();
      });

      btnCancel.addEventListener("click", function () {
        if (closed) return;
        closed = true;
        if (overlay && overlay.parentNode) {
          overlay.parentNode.removeChild(overlay);
        }
        stopScanningAsync().then(function () {
          reject(new Error("사용자가 기기 선택을 취소했습니다."));
        });
      });

      startDiscovery();
    });
  }

  navigator.bluetooth = {
    getAvailability: function () {
      return Promise.resolve(true);
    },
    getDevices: function () {
      return getReadyBle().then(function () {
        // 오직 이전에 사용자가 직접 선택하고 비밀번호 인증까지 완료하여 저장된 기기만 반환!
        var savedId = getSavedId();
        var savedName = getSavedName();
        if (savedId && savedName) {
          if (!_cachedDevice || _cachedDevice.id !== savedId) {
            _cachedDevice = new BleDevice(savedId, savedName);
          }
          return [_cachedDevice];
        }
        return [];
      }).catch(function () {
        return [];
      });
    },
    requestDevice: function () {
      return getReadyBle().then(function (BLE) {
        return openKoreaDevicePickerModal(BLE);
      });
    }
  };

  console.log("[ble-native-adapter V5] 장착 완료 (필터 무제한 표시 + rawAdvertisement 이름 해독 + scanMode 2 최고감도)");
})();
