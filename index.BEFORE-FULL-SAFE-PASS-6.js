// === ADD THIS INSIDE io.on("connection") ===

const peerMap = {};

io.on("connection", (socket) => {

  socket.on("webrtc:join", ({ roomId }) => {
    socket.join(roomId);

    if (!peerMap[roomId]) peerMap[roomId] = [];
    peerMap[roomId].push(socket.id);

    socket.to(roomId).emit("webrtc:user-joined", {
      socketId: socket.id
    });
  });

  socket.on("webrtc:signal", ({ to, signal }) => {
    io.to(to).emit("webrtc:signal", {
      from: socket.id,
      signal
    });
  });

  socket.on("disconnect", () => {
    for (const roomId in peerMap) {
      peerMap[roomId] = peerMap[roomId].filter(id => id !== socket.id);
      socket.to(roomId).emit("webrtc:user-left", {
        socketId: socket.id
      });
    }
  });

});