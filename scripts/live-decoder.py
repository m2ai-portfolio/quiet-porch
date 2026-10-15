#!/usr/bin/env python3
"""Quiet Porch live-frame decoder helper (QP-08), spawned by src/live-decoder.ts.

Python only because the GStreamer introspection bindings are the one route, proven in the
authorized Cam1 spike, to per-buffer reference-timestamp metadata; Node has no binding.

Reads the bearer token as the first stdin line (never argv, so it stays out of `ps`), receives
video only, and writes framed JPEG samples to stdout:
  b'QPF1' | u32be header_len | header JSON | u32be jpeg_len | jpeg bytes
Header: {"pts_ns": "<int>"|null, "ref": {"clock": "<caps>", "ts_ns": "<int>"}|null}
Nanosecond values are strings: NTP-epoch nanoseconds exceed JSON's exact integer range.

Exits on SIGTERM/SIGINT (pipeline to NULL = RTSP teardown), on a closed stdout (parent gone),
on a bus error (exit 3) or after --max-seconds (safety bound for battery sessions).
--test-source swaps rtspsrc for a live videotestsrc so the real decode path runs in tests.
"""
import argparse
import json
import os
import signal
import struct
import sys
import time

os.environ.setdefault("GST_DEBUG", "0")
import gi  # noqa: E402

gi.require_version("Gst", "1.0")
from gi.repository import Gst  # noqa: E402

MAGIC = b"QPF1"


def build(args, token):
    pipeline = Gst.Pipeline.new("qp-live-decoder")
    convert = Gst.ElementFactory.make("videoconvert", "convert")
    encoder = Gst.ElementFactory.make("jpegenc", "encoder")
    sink = Gst.ElementFactory.make("appsink", "sink")
    for prop, value in (("emit-signals", True), ("sync", False), ("max-buffers", 1), ("drop", True)):
        sink.set_property(prop, value)
    if args.test_source:
        source = Gst.ElementFactory.make("videotestsrc", "source")
        source.set_property("is-live", True)
        source.set_property("pattern", "ball")
        caps = Gst.ElementFactory.make("capsfilter", "caps")
        caps.set_property("caps", Gst.Caps.from_string("video/x-raw,width=320,height=240,framerate=10/1"))
        for e in (source, caps, convert, encoder, sink):
            pipeline.add(e)
        source.link(caps)
        caps.link(convert)
    else:
        source = Gst.ElementFactory.make("rtspsrc", "source")
        decode = Gst.ElementFactory.make("decodebin", "decode")
        source.set_property("location", args.location)
        source.set_property("protocols", 4)  # TCP
        source.set_property("latency", 200)
        source.set_property("tcp-timeout", 5_000_000)
        source.set_property("add-reference-timestamp-meta", True)
        source.set_property("user-id", "x")
        source.set_property("user-pw", token)
        for e in (source, decode, convert, encoder, sink):
            pipeline.add(e)
        source.connect(
            "select-stream", lambda _s, _n, caps: caps.get_structure(0).get_string("media") == "video"
        )

        def source_pad(_src, pad):
            caps = pad.get_current_caps() or pad.query_caps(None)
            if caps.get_structure(0).get_string("media") == "video":
                pad.link(decode.get_static_pad("sink"))

        def decoded_pad(_src, pad):
            caps = pad.get_current_caps() or pad.query_caps(None)
            sink_pad = convert.get_static_pad("sink")
            if caps.to_string().startswith("video/") and not sink_pad.is_linked():
                pad.link(sink_pad)

        source.connect("pad-added", source_pad)
        decode.connect("pad-added", decoded_pad)
    convert.link(encoder)
    encoder.link(sink)
    return pipeline, sink


def reference(buffer):
    try:
        meta = buffer.get_reference_timestamp_meta(None)
    except Exception:
        return None
    if not meta:
        return None
    return {"clock": meta.reference.to_string(), "ts_ns": str(int(meta.timestamp))}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--location")
    parser.add_argument("--test-source", action="store_true")
    parser.add_argument("--interval-ms", type=int, default=500)
    parser.add_argument("--max-seconds", type=float, default=35.0)
    args = parser.parse_args()
    if not args.test_source and not (args.location or "").startswith("rtsps://"):
        print("bad_location", file=sys.stderr)
        return 2
    token = sys.stdin.readline().strip()
    sys.stdin.close()
    if not args.test_source and not token:
        print("no_token", file=sys.stderr)
        return 2

    Gst.init(None)
    pipeline, sink = build(args, token)
    del token
    out = sys.stdout.buffer
    state = {"last": 0.0, "stop": False, "broken": False}

    def on_sample(app):
        sample = app.emit("pull-sample")
        if not sample:
            return Gst.FlowReturn.ERROR
        now = time.monotonic()
        if (now - state["last"]) * 1000 < args.interval_ms:
            return Gst.FlowReturn.OK
        state["last"] = now
        buffer = sample.get_buffer()
        ok, mapped = buffer.map(Gst.MapFlags.READ)
        if not ok:
            return Gst.FlowReturn.OK
        try:
            jpeg = bytes(mapped.data)
        finally:
            buffer.unmap(mapped)
        pts = None if buffer.pts == Gst.CLOCK_TIME_NONE else str(int(buffer.pts))
        header = json.dumps({"pts_ns": pts, "ref": reference(buffer)}).encode()
        try:
            out.write(MAGIC + struct.pack(">I", len(header)) + header + struct.pack(">I", len(jpeg)) + jpeg)
            out.flush()
        except (BrokenPipeError, OSError):
            state["broken"] = True
        return Gst.FlowReturn.OK

    sink.connect("new-sample", on_sample)
    signal.signal(signal.SIGTERM, lambda *_: state.update(stop=True))
    signal.signal(signal.SIGINT, lambda *_: state.update(stop=True))
    started = time.monotonic()
    code = 0
    pipeline.set_state(Gst.State.PLAYING)
    bus = pipeline.get_bus()
    try:
        while not state["stop"] and not state["broken"] and time.monotonic() - started < args.max_seconds:
            message = bus.timed_pop_filtered(100 * Gst.MSECOND, Gst.MessageType.ERROR | Gst.MessageType.EOS)
            if message:
                if message.type == Gst.MessageType.ERROR:
                    err, _debug = message.parse_error()
                    kind = "unauthorized" if "Unauthorized" in (err.message or "") else "resource_error"
                    print(f"decoder_error {kind}", file=sys.stderr)
                    code = 3
                break
    finally:
        pipeline.set_state(Gst.State.NULL)  # RTSP TEARDOWN
    return code


if __name__ == "__main__":
    sys.exit(main())
