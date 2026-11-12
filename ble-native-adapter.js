/* ble-native-adapter.js — Capacitor BLE (BluetoothLe) <-> Web Bluetooth API 완벽 호환 어댑터
 * - APK(Capacitor Android) 환경에서는 즉시(동기적으로) navigator.bluetooth 를 설치하여
 *   DOMContentLoaded 시점의 자동 재연결(getDevices)이 100% 동작하도록 보장
 * - 한번 연결한 기기 ID(MAC)와 이름을 localStorage(ble_native_device_id / ble_native_device_name)에 영구 저장
 * - write: Hex 문자열 인코딩 (BluetoothLe 플러그인 표준 규격)
 * - startNotifications: Capacitor 이벤트 키("notification|deviceId|service|char") + addEventListener 완벽 지원
 * - disconnected 이벤트: "disconnected|deviceId" 감지 후 gattserverdisconnected 즉시 발생
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
          BLE.initialize({ androidNeverForLocation: true })
            .catch(function () {})
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
      if ( self._capHandle && typeof self._capHandle.remove === "function") {
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
            try {
              localStorage.setItem(LS_DEV_ID, self.id);
              localStorage.setItem(LS_DEV_NAME, self.name);
            } catch (e) {}
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

  navigator.bluetooth = {
    getAvailability: function () {
      return Promise.resolve(true);
    },
    getDevices: function () {
      return getReadyBle().then(function () {
        var savedId = localStorage.getItem(LS_DEV_ID);
        var savedName = localStorage.getItem(LS_DEV_NAME) || localStorage.getItem("ble_last_device_name") || "korea";
        if (savedId) {
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
    requestDevice: function (options) {
      return getReadyBle().then(function (BLE) {
        var savedId = localStorage.getItem(LS_DEV_ID);
        var savedName = localStorage.getItem(LS_DEV_NAME) || localStorage.getItem("ble_last_device_name") || "korea";
        if (savedId) {
          if (!_cachedDevice || _cachedDevice.id !== savedId) {
            _cachedDevice = new BleDevice(savedId, savedName);
          }
          return _cachedDevice;
        }

        var reqOpts = { services: [SERVICE_UUID] };
        if (options && Array.isArray(options.filters) && options.filters.length > 0) {
          var f0 = options.filters[0];
          if (f0.namePrefix) reqOpts.namePrefix = f0.namePrefix;
          if (f0.name) reqOpts.name = f0.name;
        } else {
          reqOpts.namePrefix = "korea";
        }

        return BLE.requestDevice(reqOpts).then(function (dev) {
          var dId = dev.deviceId || dev.id;
          var dName = dev.name || "korea";
          try {
            localStorage.setItem(LS_DEV_ID, dId);
            localStorage.setItem(LS_DEV_NAME, dName);
          } catch (e) {}
          _cachedDevice = new BleDevice(dId, dName);
          return _cachedDevice;
        });
      });
    }
  };

  console.log("[ble-native-adapter] Capacitor BLE 어댑터 즉시 장착 완료 (자동재연결/Hex전송/Notify완벽호환)");
})();
