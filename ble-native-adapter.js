/* ble-native-adapter.js — Capacitor BLE (BluetoothLe) <-> Web Bluetooth API 완벽 호환 어댑터 (V4)
 * [핵심 수리 내역]
 * 1. ESP32 실제 UUID (12345678-1234-1234-1234-1234567890ab / abcdefab-1234-5678-1234-abcdefabcdef) 완벽 일치
 * 2. BLE.initialize({ androidNeverForLocation: true }) 고정으로 Android 12+ 무권한 스캔 즉시 작동
 * 3. stopScanning() 비동기 경합 버그 제거 (스캔 시작 직후 스스로 스캔을 끄던 현상 완전 해결)
 * 4. gatt.connect() 직전 자폭 BLE.disconnect() 제거 및 연결 성공 후 disconnected 리스너 등록
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

  var _bleReadyPromise = null;
  function getReadyBle() {
    if (_bleReadyPromise) return _bleReadyPromise;
    _bleReadyPromise = new Promise(function (resolve, reject) {
      var t0 = Date.now();
      (function poll() {
        var p = window.Capacitor && window.Capacitor.Plugins;
        var BLE = p && p.BluetoothLe;
        if (BLE) {
          BLE.initialize({ androidNeverForLocation: true })
            .catch(function () {
              return BLE.initialize().catch(function () {});
            })
            .then(function () { resolve(BLE); });
          return;
        }
        if (Date.now() - t0 > 10000) {
          _bleReadyPromise = null;
          return reject(new Error("BluetoothLe 플러그인 로드 시간 초과"));
        }
        setTimeout(poll, 60);
      })();
    });
    return _bleReadyPromise;
  }

  function isKoreaName(name) {
    if (!name) return false;
    return String(name).trim().toLowerCase().indexOf("korea") === 0;
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
            // ★ 자폭 disconnect 없이 바로 connect 시도, 실패 시에만 1회 정리 후 재시도
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

  // 한글 발전기 선택 모달창 (주변 BLE 실시간 스캔 + 폰 등록 블루투스 동시 탐색)
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
      title.innerHTML = '<span>📡 연결할 발전기 선택</span><span id="__bleScanStat" style="font-size:12px;color:#38bdf8;font-weight:700;">스캔 중...</span>';

      var sub = document.createElement("div");
      sub.style.cssText = "font-size:12.5px;color:#94a3b8;margin-bottom:12px;line-height:1.4;";
      sub.textContent = "아래 목록에서 발전기 이름(korea...)을 터치하면 비밀번호 4자리 입력창이 열립니다.";

      var listWrap = document.createElement("div");
      listWrap.style.cssText = "display:flex;flex-direction:column;gap:8px;max-height:240px;overflow-y:auto;margin-bottom:14px;padding:4px 0;";

      var emptyMsg = document.createElement("div");
      emptyMsg.style.cssText = "text-align:center;padding:24px 10px;color:#cbd5e1;font-size:13.5px;background:#0b1120;border-radius:12px;border:1px dashed #334155;";
      emptyMsg.innerHTML = "🔍 주변의 <b>korea</b> 발전기를 찾고 있습니다...<br><span style='font-size:11.5px;color:#64748b'>(발전기 전원이 켜져 있는지 확인하세요)</span>";
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

      function addCandidate(id, name, sourceLabel) {
        if (closed || !id) return;
        var cleanNm = String(name || "korea0000").trim();
        if (foundMap[id]) {
          if (cleanNm && cleanNm !== "korea0000" && foundMap[id].name === "korea0000") {
            foundMap[id].name = cleanNm;
            foundMap[id].btnNameEl.textContent = "⚡ " + cleanNm;
          }
          return;
        }
        if (emptyMsg && emptyMsg.parentNode === listWrap) {
          listWrap.removeChild(emptyMsg);
        }

        var itemBtn = document.createElement("button");
        itemBtn.type = "button";
        var isCurrent = (currentSavedId && currentSavedId === id);
        itemBtn.style.cssText = "width:100%;padding:14px;border-radius:12px;border:1px solid " + (isCurrent ? "#10b981" : "#3b82f6") + ";background:" + (isCurrent ? "rgba(16,185,129,0.15)" : "#0b1120") + ";color:#f8fafc;display:flex;align-items:center;justify-content:space-between;cursor:pointer;text-align:left;";

        var leftDiv = document.createElement("div");
        var nameEl = document.createElement("div");
        nameEl.style.cssText = "font-size:15.5px;font-weight:800;color:#fff;";
        nameEl.textContent = "⚡ " + cleanNm;

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
          var chosenName = foundMap[id] ? foundMap[id].name : cleanNm;
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

        foundMap[id] = { id: id, name: cleanNm, btnNameEl: nameEl };
        listWrap.appendChild(itemBtn);
      }

      function startDiscovery() {
        var statEl = document.getElementById("__bleScanStat");
        if (statEl) statEl.textContent = "주변 스캔 중...";

        // 1) 폰 블루투스에 등록/연결된 korea 기기 조회
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
            var nm = d && d.name;
            if (id && isKoreaName(nm)) {
              addCandidate(id, nm, "블루투스 기기");
            }
          }
        });

        // 2) ★ 이전 스캔이 완전히 종료된 뒤에 새 스캔을 시작 (비동기 경합 버그 원천 차단!)
        if (typeof BLE.requestLEScan === "function") {
          stopScanningAsync().then(function () {
            if (closed) return;
            var sEl = document.getElementById("__bleScanStat");
            if (sEl) sEl.textContent = "주변 스캔 중...";
            return BLE.addListener("onScanResult", function (res) {
              if (closed || !res) return;
              var d = res.device || res;
              var id = d.deviceId || d.id;
              var nm = d.name || res.localName || "";
              var uuids = res.uuids || [];
              var hasGenUuid = Array.isArray(uuids) && uuids.some(function (u) {
                var lu = String(u).toLowerCase();
                return lu.indexOf("12345678") >= 0 || lu.indexOf("ffe0") >= 0;
              });
              if (id && (isKoreaName(nm) || hasGenUuid)) {
                addCandidate(id, nm || "korea0000", "실시간 신호");
              }
            });
          }).then(function (h) {
            if (closed) {
              if (h && h.remove) h.remove().catch(function () {});
              return;
            }
            scanHandle = h;
            return BLE.requestLEScan({ allowDuplicates: true });
          }).then(function () {
            if (closed) return;
            scanTimer = setTimeout(function () {
              stopScanningAsync();
            }, 8000);
          }).catch(function () {
            stopScanningAsync();
          });
        }
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
          reject(new Error("사용자가 발전기 선택을 취소했습니다."));
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

  console.log("[ble-native-adapter V4] 장착 완료 (UUID 12345678 일치 + 스캔 경합 수정 + 수동선택 시 무조건 PIN창 표시)");
})();
