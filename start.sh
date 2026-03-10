#!/bin/bash
node server.js &
SERVER_PID=$!
echo "Server started with PID: $SERVER_PID"
echo $SERVER_PID > .server.pid
