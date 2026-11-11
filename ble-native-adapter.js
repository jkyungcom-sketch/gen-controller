/* =====================================================================
 * ble-native-adapter.js  —  Capacitor 네이티브 BLE 어댑터
 * ---------------------------------------------------------------------
 * 목적: 순수 웹 index.html 을 통째로 교체해도 APK 빌드 시 이 파일이
 *       자동 주입되어 네이티브 BLE + MAC(deviceId) 자동 재연결이 동작.
 * 방식: navigator.bluetooth 를 Capacitor BluetoothLe 로 감싼 프록시 설치.
 *       (index.html 쪽 코드는 단 한 줄도 수정할 필요 없음)
 * ===================================================================== */
(function () {
  "use strict";

  var Cap = window.Capacitor;
  var IS_NATIVE = !!(Cap && Cap.isNativePlatform && Cap.isNativePlatform());
  window.__IS_NATIVE = IS_NATIVE;
  if (!IS_NATIVE) { console.log("[adapter] 웹 모드 — 개입하지 않음"); return; }

  var BLE = (Cap.Plugins && Cap.Plugins.BluetoothLe) || null;
  var Prefs = (Cap.Plugins && Cap.Plugins.Preferences) || null;
  if (!BLE) { console.warn("[adapter] BluetoothLe 플러그인 없음"); return; }

  var PREF_KEY = "auth_gen_device_id";
  var initP = null;

  function init() {
    if (initP) return initP;
    initP = BLE.initialize({ androidNeverForLocation: true })
      .then(function () { console.log("[adapter] initialize OK"); return true; })
      .catch(function (e) { console.log("[adapter] initialize 실패", e); initP = null; return false; });
    return initP;
  }

  function saveId(id) {
    try { localStorage.setItem(PREF_KEY, id); } catch (e) {}
    if (Prefs) { Prefs.set({ key: PREF_KEY, value: id }).catch(function () {}); }
    console.log("[adapter] deviceId 저장:", id);
  }

  function loadId() {
    var v = null;
    try { v = localStorage.getItem(PREF_KEY); } catch (e) {}
    return v;
  }

  // ── 스캔 (이름 필터 지원) ──────────────────────────────────────
  function scan(nameFilter, timeoutMs) {
    return init().then(function () {
      return new Promise(function (resolve) {
        var found = null, done = false;
        function finish(v) {
          if (done) return; done = true;
          try { BLE.stopLEScan(); } catch (e) {}
          try { BLE.removeAllListeners("onScanResult"); } catch (e) {}
          resolve(v);
        }
        BLE.addListener("onScanResult", function (r) {
          var d = r && r.device;
          if (!d) return;
          if (!nameFilter || d.name === nameFilter) { found = d; finish(d); }
        }).then(function () {
          var opts = { allowDuplicates: false, scanMode: 1 };
          if (nameFilter) opts.namePrefix = nameFilter;
          return BLE.requestLEScan(opts);
        }).catch(function (e) { console.log("[adapter] scan err", e); });
        setTimeout(function () { finish(found); }, timeoutMs || 12000);
      });
    });
  }

  // ── 웹 호환 device shim ────────────────────────────────────────
  function makeShim(dev) {
    var shim = {
      name: dev.name || "",
      id: dev.deviceId,
      __native: true,
      __notifyCb: null,
      __disconnCb: null,
      __deviceId: dev.deviceId,
      addEventListener: function (ev, cb) {
        if (ev === "gattserverdisconnected") shim.__disconnCb = cb;
      },
      removeEventListener: function () {},
      gatt: {
        connected: false,
        connect: function () {
          return init().then(function () {
            if (shim.__disconnCb) {
              BLE.addListener("onDisconnect", function (r) {
                if (r && r.device && r.device.deviceId === shim.__deviceId) {
                  shim.gatt.connected = false;
                  try { shim.__disconnCb(); } catch (e) {}
                }
              }).catch(function () {});
            }
            return BLE.connect({ deviceId: shim.__deviceId, timeout: 15000 });
          }).then(function () {
            shim.gatt.connected = true;
            return {
              getPrimaryService: function (svc) {
                return Promise.resolve({
                  getCharacteristic: function (chr) {
                    return Promise.resolve({
                      startNotifications: function () {
                        return BLE.startNotifications({
                          deviceId: shim.__deviceId,
                          service: svc,
                          characteristic: chr,
                          callback: function (v) {
                            if (shim.__notifyCb) { shim.__notifyCb(v); }
                          }
                        });
                      },
                      writeValue: function (buf) {
                        var arr = new Uint8Array(buf);
                        var bin = "";
                        for (var i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]);
                        return BLE.write({
                          deviceId: shim.__deviceId,
                          service: svc,
                          characteristic: chr,
                          value: btoa(bin)
                        });
                      }
                    });
                  }
                });
              }
            };
          });
        },
        disconnect: function () {
          return BLE.disconnect({ deviceId: shim.__deviceId })
            .catch(function () {})
            .then(function () { shim.gatt.connected = false; });
        }
      }
    };
    return shim;
  }

  // ── navigator.bluetooth 프록시 설치 ────────────────────────────
  var saved = loadId();

  var proxy = {
    getAvailability: function () { return Promise.resolve(true); },

    // ★ 핵심: 저장된 deviceId 가 있으면 검색 팝업 없이 즉시 반환
    getDevices: function () {
      return init().then(function () {
        var id = loadId();
        if (!id) return [];
        return BLE.getDevices ? BLE.getDevices() : { devices: [] }
          .then(function (res) {
            var list = (res && res.devices) || [];
            var hit = list.filter(function (d) { return d.deviceId === id; });
            return hit.map(makeShim);
          });
      }).catch(function () { return []; });
    },

    // ★ 핵심: 저장된 deviceId 로 다이렉트 연결 (스캔 없음)
    requestDevice: function (options) {
      options = options || {};
      return init().then(function () {
        var wantName = null;
        if (options.filters && options.filters.length && options.filters[0].name) {
          wantName = options.filters[0].name;
        }

        // 1) 저장된 deviceId 가 있으면 그걸로 바로
        var id = loadId();
        if (id) {
          var dev = { deviceId: id, name: wantName || (localStorage.getItem("auth_gen_name") || "") };
          return makeShim(dev);
        }

        // 2) 저장된 게 없으면 스캔 (사용자가 기기 선택하는 상황)
        return scan(wantName, 12000).then(function (d) {
          if (!d) throw new Error("no device found");
          saveId(d.deviceId);
          if (d.name) { try { localStorage.setItem("auth_gen_name", d.name); } catch (e) {} }
          return makeShim(d);
        });
      });
    }
  };

  try {
    Object.defineProperty(navigator, "bluetooth", {
      value: proxy, writable: true, configurable: true
    });
    console.log("[adapter] navigator.bluetooth 프록시 설치 완료 / savedId =", saved);
  } catch (e) {
    console.warn("[adapter] 프록시 설치 실패", e);
  }

  // 부팅 시 미리 초기화 + 저장 기기 조용한 재연결 워밍업
  document.addEventListener("deviceready", function () { init(); }, { once: true });
  window.addEventListener("load", function () {
    init().then(function (ok) {
      if (ok) console.log("[adapter] 준비 완료. 저장된 deviceId:", loadId());
    });
  });
})();
