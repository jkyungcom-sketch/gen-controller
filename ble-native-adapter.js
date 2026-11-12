/* ble-native-adapter.js — Capacitor BLE (BluetoothLe) <-> Web Bluetooth API 완벽 호환 어댑터 (V2)
 * - APK(Capacitor Android) 환경에서 즉시(동기적으로) navigator.bluetooth 장착
 * - 1순위: 저장된 기기 ID(MAC: ble_native_device_id / ble_last_id)로 무팝업 즉시 직결
 * - 2순위: 폰 기본 블루투스에 등록(페어링)된 기기(getBondedDevices / getConnectedDevices)에서 'korea' 자동 탐색
 * - 3순위: 백그라운드 고속 무필터 스캔(requestLEScan)으로 'korea' 자동 발견 및 즉시 연결 (안드로이드 UUID 하드웨어 필터 버그 완전 우회)
 * - 4순위: 폴백 시에도 services 필수 필터를 제거하고 optionalServices + namePrefix:'korea' 로 스캔창 호출
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

  var SERVICE_UUID = "0000ffe0-0000-1000-8000-00805f9b34fb";
  var CHAR_UUID    = "0000ffe1-0000-1000-8000-00805f9b34fb";
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
          BLE.initialize()
            .catch(function () {
              return BLE.initialize({ androidNeverForLocation: true }).catch(function () {});
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

  function BleDevice(devId, devName) {
    var self = this;
    this.id = devId;
    this.name = devName || "korea";
    this._listeners = {};
    this._discHandle = null;
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
            return BLE.addListener("disconnected|" + self.id, function () {
              self.gatt.connected = false;
              self._emit("gattserverdisconnected", { target: self });
            });
          }).then(function (h) {
            self._discHandle = h;
            return BLE.disconnect({ deviceId: self.id }).catch(function () {});
          }).then(function () {
            return BLE.connect({ deviceId: self.id });
          }).then(function () {
            self.gatt.connected = true;
            saveDeviceIdentity(self.id, self.name);
            return self.gatt;
          });
        });
      },
      disconnect: function () {
        self.gatt.connected = false;
        getReadyBle().then(function (BLE) {
          return BLE.disconnect({ deviceId: self.id });
        }).catch(function () {});
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

  // 폰 기본 설정에 페어링(등록)되었거나 이미 연결된 기기 중 'korea' 탐색
  function findBondedOrConnectedKorea(BLE) {
    var found = [];
    var pConn = (typeof BLE.getConnectedDevices === "function")
      ? BLE.getConnectedDevices({ services: [SERVICE_UUID] }).catch(function () { return { devices: [] }; })
      : Promise.resolve({ devices: [] });
    var pBond = (typeof BLE.getBondedDevices === "function")
      ? BLE.getBondedDevices().catch(function () { return { devices: [] }; })
      : Promise.resolve({ devices: [] });

    return Promise.all([pConn, pBond]).then(function (res) {
      var list1 = (res[0] && res[0].devices) || [];
      var list2 = (res[1] && res[1].devices) || [];
      var all = list1.concat(list2);
      var seen = {};
      for (var i = 0; i < all.length; i++) {
        var d = all[i];
        var id = d && (d.deviceId || d.id);
        var nm = d && d.name;
        if (id && !seen[id] && isKoreaName(nm)) {
          seen[id] = true;
          found.push({ id: id, name: nm });
        }
      }
      return found;
    });
  }

  // 하드웨어 UUID 필터 없이 백그라운드 스캔(requestLEScan)으로 'korea' 자동 탐색
  function autoScanKoreaDevice(BLE, timeoutMs) {
    if (typeof BLE.requestLEScan !== "function") {
      return Promise.resolve(null);
    }
    return new Promise(function (resolve) {
      var resolved = false;
      var scanHandle = null;
      var timer = null;

      function finish(devObj) {
        if (resolved) return;
        resolved = true;
        if (timer) clearTimeout(timer);
        Promise.resolve()
          .then(function () {
            if (typeof BLE.stopLEScan === "function") {
              return BLE.stopLEScan().catch(function () {});
            }
          })
          .then(function () {
            if (scanHandle && typeof scanHandle.remove === "function") {
              return scanHandle.remove().catch(function () {});
            }
          })
          .then(function () {
            resolve(devObj || null);
          });
      }

      BLE.addListener("onScanResult", function (res) {
        if (resolved || !res) return;
        var d = res.device || res;
        var id = d.deviceId || d.id;
        var nm = d.name || res.localName || "";
        var uuids = res.uuids || [];
        var hasFfe0 = Array.isArray(uuids) && uuids.some(function (u) {
          return String(u).toLowerCase().indexOf("ffe0") >= 0;
        });
        if (id && (isKoreaName(nm) || hasFfe0)) {
          finish({ id: id, name: nm || "korea" });
        }
      }).then(function (h) {
        scanHandle = h;
        return BLE.requestLEScan({ allowDuplicates: true });
      }).then(function () {
        timer = setTimeout(function () {
          finish(null);
        }, timeoutMs || 3500);
      }).catch(function () {
        finish(null);
      });
    });
  }

  navigator.bluetooth = {
    getAvailability: function () {
      return Promise.resolve(true);
    },
    getDevices: function () {
      return getReadyBle().then(function (BLE) {
        var savedId = getSavedId();
        var savedName = getSavedName() || "korea";
        if (savedId) {
          if (!_cachedDevice || _cachedDevice.id !== savedId) {
            _cachedDevice = new BleDevice(savedId, savedName);
          }
          return [_cachedDevice];
        }
        // 저장된 ID가 없더라도 폰 기본 블루투스에 'korea'가 페어링돼 있으면 자동 인식!
        return findBondedOrConnectedKorea(BLE).then(function (list) {
          if (list && list.length > 0) {
            var d0 = list[0];
            saveDeviceIdentity(d0.id, d0.name);
            _cachedDevice = new BleDevice(d0.id, d0.name);
            return [_cachedDevice];
          }
          return [];
        });
      }).catch(function () {
        return [];
      });
    },
    requestDevice: function (options) {
      return getReadyBle().then(function (BLE) {
        // 1순위: 이미 저장된 기기 ID가 있으면 즉시 반환
        var savedId = getSavedId();
        var savedName = getSavedName() || "korea";
        if (savedId) {
          if (!_cachedDevice || _cachedDevice.id !== savedId) {
            _cachedDevice = new BleDevice(savedId, savedName);
          }
          return _cachedDevice;
        }

        // 2순위: 폰 기본 설정(블루투스)에 페어링/연결된 'korea'가 있으면 즉시 반환
        return findBondedOrConnectedKorea(BLE).then(function (bondedList) {
          if (bondedList && bondedList.length === 1) {
            var b0 = bondedList[0];
            saveDeviceIdentity(b0.id, b0.name);
            _cachedDevice = new BleDevice(b0.id, b0.name);
            return _cachedDevice;
          }

          // 3순위: 백그라운드 무필터 스캔(requestLEScan)으로 'korea' 자동 탐색 (스캔 팝업 없이 즉시 연결!)
          return autoScanKoreaDevice(BLE, 3500).then(function (scanned) {
            if (scanned && scanned.id) {
              saveDeviceIdentity(scanned.id, scanned.name);
              _cachedDevice = new BleDevice(scanned.id, scanned.name);
              return _cachedDevice;
            }

            // 4순위: 폴백 — 네이티브 선택창 호출 (★ services 필수 필터 제외! optionalServices 만 전달)
            return BLE.requestDevice({
              namePrefix: "korea",
              optionalServices: [SERVICE_UUID]
            }).catch(function () {
              // namePrefix 도 안 먹히는 특이 기종 폴백: 전체 BLE 목록 표시
              return BLE.requestDevice({
                optionalServices: [SERVICE_UUID]
              });
            }).then(function (dev) {
              var dId = dev.deviceId || dev.id;
              var dName = dev.name || "korea";
              saveDeviceIdentity(dId, dName);
              _cachedDevice = new BleDevice(dId, dName);
              return _cachedDevice;
            });
          });
        });
      });
    }
  };

  console.log("[ble-native-adapter V2] 장착 완료 (저장기기 직결 + 폰 페어링 연동 + 무필터 자동스캔)");
})();
