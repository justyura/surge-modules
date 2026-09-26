// UTF-8 的 TextEncoder / TextDecoder 补丁。
// Apple TV 上的 Surge 只有 JavaScriptCore，没有这两个；系统自带的话什么也不做。
// 只支持 UTF-8，覆盖 encode(str)、decode(bytes)、{ fatal, ignoreBOM } 这几种用法。
(function (root) {
  if (typeof root.TextEncoder === 'function' && typeof root.TextDecoder === 'function') return;

  function TextEncoder() {}
  TextEncoder.prototype.encoding = 'utf-8';
  TextEncoder.prototype.encode = function (input) {
    var str = input === undefined ? '' : String(input);
    var out = new Uint8Array(str.length * 3);
    var n = 0;
    for (var i = 0; i < str.length; i++) {
      var cp = str.charCodeAt(i);
      if (cp >= 0xd800 && cp <= 0xdbff && i + 1 < str.length) {
        var lo = str.charCodeAt(i + 1);
        if (lo >= 0xdc00 && lo <= 0xdfff) {
          cp = 0x10000 + ((cp - 0xd800) << 10) + (lo - 0xdc00);
          i++;
        } else {
          cp = 0xfffd;
        }
      } else if (cp >= 0xd800 && cp <= 0xdfff) {
        cp = 0xfffd; // 落单的代理对
      }
      if (cp < 0x80) {
        out[n++] = cp;
      } else if (cp < 0x800) {
        out[n++] = 0xc0 | (cp >> 6);
        out[n++] = 0x80 | (cp & 0x3f);
      } else if (cp < 0x10000) {
        out[n++] = 0xe0 | (cp >> 12);
        out[n++] = 0x80 | ((cp >> 6) & 0x3f);
        out[n++] = 0x80 | (cp & 0x3f);
      } else {
        out[n++] = 0xf0 | (cp >> 18);
        out[n++] = 0x80 | ((cp >> 12) & 0x3f);
        out[n++] = 0x80 | ((cp >> 6) & 0x3f);
        out[n++] = 0x80 | (cp & 0x3f);
      }
    }
    return out.slice(0, n);
  };

  function TextDecoder(label, options) {
    var name = String(label === undefined ? 'utf-8' : label).toLowerCase();
    if (name !== 'utf-8' && name !== 'utf8') throw new RangeError('只支持 utf-8：' + label);
    this.encoding = 'utf-8';
    this.fatal = !!(options && options.fatal);
    this.ignoreBOM = !!(options && options.ignoreBOM);
  }

  function toBytes(input) {
    if (input === undefined || input === null) return new Uint8Array(0);
    if (input instanceof Uint8Array) return input;
    if (input instanceof ArrayBuffer) return new Uint8Array(input);
    if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    throw new TypeError('decode 需要 ArrayBuffer 或 TypedArray');
  }

  TextDecoder.prototype.decode = function (input) {
    var bytes = toBytes(input);
    var fatal = this.fatal;
    var i = 0;
    if (!this.ignoreBOM && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) i = 3;
    var chunks = [];
    var codes = [];

    function bad() {
      if (fatal) throw new TypeError('The encoded data was not valid for encoding utf-8');
      codes.push(0xfffd);
    }

    while (i < bytes.length) {
      var b = bytes[i];
      var need = 0;
      var cp = 0;
      var min = 0;
      if (b < 0x80) { codes.push(b); i++; }
      else {
        if (b >= 0xc2 && b <= 0xdf) { need = 1; cp = b & 0x1f; min = 0x80; }
        else if (b >= 0xe0 && b <= 0xef) { need = 2; cp = b & 0x0f; min = 0x800; }
        else if (b >= 0xf0 && b <= 0xf4) { need = 3; cp = b & 0x07; min = 0x10000; }
        else { bad(); i++; continue; }
        var j = 1;
        for (; j <= need; j++) {
          var c = bytes[i + j];
          if (c === undefined || (c & 0xc0) !== 0x80) break;
          cp = (cp << 6) | (c & 0x3f);
        }
        if (j <= need || cp < min || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) {
          bad();
          i += Math.max(1, j);
          continue;
        }
        i += need + 1;
        if (cp >= 0x10000) {
          cp -= 0x10000;
          codes.push(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff));
        } else {
          codes.push(cp);
        }
      }
      if (codes.length >= 8192) {
        chunks.push(String.fromCharCode.apply(null, codes));
        codes = [];
      }
    }
    chunks.push(String.fromCharCode.apply(null, codes));
    return chunks.join('');
  };

  root.TextEncoder = TextEncoder;
  root.TextDecoder = TextDecoder;
})(typeof globalThis !== 'undefined' ? globalThis : this);
