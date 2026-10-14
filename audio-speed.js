(function (global) {
  'use strict';

  function setPitchPreservation(audio, enabled) {
    ['preservesPitch', 'mozPreservesPitch', 'webkitPreservesPitch'].forEach(function (key) {
      if (key in audio) {
        try { audio[key] = enabled; } catch (_) { /* browser may expose a read-only alias */ }
      }
    });
  }

  function create(audio, options) {
    options = options || {};
    var mode = 'native';
    var context = null;
    var source = null;
    var node = null;
    var processorAvailable = false;
    var nativeOutputConnected = false;
    var signalsmithOutputConnected = false;
    var fallbackReported = false;
    var fallbackReason = '';
    var closed = false;
    var currentRate = audio && Number(audio.playbackRate) || 1;

    function reportFallback(reason) {
      fallbackReason = reason || '当前浏览器无法启用音高补偿处理';
      if (!fallbackReported && typeof options.onFallback === 'function') {
        fallbackReported = true;
        options.onFallback(fallbackReason);
      }
    }

    function pitchCompensation(rate) {
      return -12 * Math.log2(rate);
    }

    function schedulePitch(rate) {
      if (mode !== 'signalsmith' || !node || closed) return;
      var output = context.currentTime + 0.12;
      node.schedule({
        output: output,
        semitones: pitchCompensation(rate),
        formantCompensation: true
      }).catch(function (error) {
        if (global.console && typeof global.console.warn === 'function') global.console.warn('Signalsmith pitch update failed', error);
      });
    }

    function useNativePitchPreservation() {
      if (signalsmithOutputConnected) {
        try { source.disconnect(node); } catch (_) {}
        try { node.disconnect(context.destination); } catch (_) {}
        signalsmithOutputConnected = false;
      }
      if (!nativeOutputConnected) {
        source.connect(context.destination);
        nativeOutputConnected = true;
      }
      mode = 'native';
      setPitchPreservation(audio, true);
    }

    function useSignalsmithPitchCompensation(rate) {
      if (nativeOutputConnected) {
        try { source.disconnect(context.destination); } catch (_) {}
        nativeOutputConnected = false;
      }
      if (!signalsmithOutputConnected) {
        source.connect(node);
        node.connect(context.destination);
        signalsmithOutputConnected = true;
      }
      mode = 'signalsmith';
      setPitchPreservation(audio, false);
      schedulePitch(rate);
    }

    function useNative(reason) {
      if (node) {
        if (signalsmithOutputConnected) {
          try { source.disconnect(node); } catch (_) {}
          try { node.disconnect(context.destination); } catch (_) {}
          signalsmithOutputConnected = false;
        }
      }
      mode = 'native';
      processorAvailable = false;
      setPitchPreservation(audio, true);
      if (source && context && context.destination && !nativeOutputConnected) {
        try { source.connect(context.destination); nativeOutputConnected = true; } catch (_) { /* already connected */ }
      }
      reportFallback(reason);
    }

    var controller = {
      resume: async function () {
        if (closed) return;
        if (mode === 'signalsmith' && context && context.state === 'suspended') await context.resume();
      },
      setRate: function (rate) {
        var value = Number(rate);
        if (!Number.isFinite(value) || value < 0.5 || value > 2) return false;
        currentRate = value;
        audio.playbackRate = value;
        if (processorAvailable) {
          if (value <= 1) useNativePitchPreservation();
          else useSignalsmithPitchCompensation(value);
        } else setPitchPreservation(audio, true);
        return true;
      },
      getMode: function () { return mode; },
      getFallbackReason: function () { return fallbackReason; },
      close: async function () {
        if (closed) return;
        closed = true;
        if (node) { try { node.disconnect(); } catch (_) {} }
        if (source) { try { source.disconnect(); } catch (_) {} }
        if (context && context.state !== 'closed') await context.close();
      }
    };

    return (async function () {
      var AudioContextClass = global.AudioContext || global.webkitAudioContext;
      if (!global.isSecureContext || !AudioContextClass || !global.AudioWorkletNode || !global.SignalsmithStretch || !audio || typeof audio.playbackRate !== 'number') {
        reportFallback('当前环境不支持安全的 AudioWorklet，使用浏览器原生倍速');
        return controller;
      }
      try {
        context = new AudioContextClass();
        var resumePromise = context.state === 'suspended' ? context.resume().then(function () { return null; }, function (error) { return error; }) : Promise.resolve(null);
        source = context.createMediaElementSource(audio);
        node = await global.SignalsmithStretch(context);
        await node.start();
        var resumeError = await resumePromise;
        if (resumeError) throw resumeError;
        processorAvailable = true;
        if (currentRate <= 1) useNativePitchPreservation();
        else useSignalsmithPitchCompensation(currentRate);
        return controller;
      } catch (error) {
        if (global.console && typeof global.console.warn === 'function') global.console.warn('AudioSpeed initialization failed', error);
        useNative('音高补偿处理初始化失败，已切换为浏览器原生倍速');
        return controller;
      }
    })();
  }

  global.AudioSpeed = { create: create };
})(window);
