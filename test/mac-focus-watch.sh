#!/bin/sh
# Run on the Mac while an agent drives Chrome through the relay.
# Prints a line every time the frontmost app changes. If "Google Chrome"
# shows up while you did not click it, something still takes focus.
# Stop with Ctrl-C.
prev=""
while :; do
  cur=$(lsappinfo info -only name "$(lsappinfo front)" | sed -E 's/.*= *"?([^"]*)"?$/\1/')
  if [ "$cur" != "$prev" ]; then
    printf '%s %s\n' "$(date +%H:%M:%S)" "$cur"
    prev=$cur
  fi
  sleep 0.2
done
