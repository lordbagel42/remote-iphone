#!/bin/bash
# Fake pymobiledevice3 for testing iphone.py up against the simulator's WDA.
case "$1 $2" in
  "apps list") echo '{"dev.raygen.WebDriverAgentRunner.xctrunner":{"CFBundleExecutable":"WebDriverAgentRunner-Runner"},"com.other":{"CFBundleExecutable":"Other"}}';;
  "mounter auto-mount") echo "DeveloperDiskImage already mounted";;
  "developer dvt")
    echo "xcuitest args: $*" >> /tmp/fake-pmd3.calls
    while [ $# -gt 0 ]; do [ "$1" = --output-log ] && LOG="$2"; shift; done
    sleep 3; echo "ServerURLHere->http://127.0.0.1:8100<-ServerURLHere" > "$LOG"
    sleep ${FAKE_LIFETIME:-20}; exit 1;;
  *) echo "unexpected: $*" >&2; exit 2;;
esac
