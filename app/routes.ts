import { type RouteConfig, index, route } from "@react-router/dev/routes";

export default [
  index("routes/home.tsx"),
  route("room", "routes/room.index.tsx"),
  route("room/:roomId", "routes/room.tsx"),

  route("api/auth/*", "routes/api.auth.$.ts"),
  // Student sign-in by device key (VRIP-13).
  route("api/device/challenge", "routes/api.device.challenge.ts"),
  route("api/device/session", "routes/api.device.session.ts"),
  route("api/socket-token", "routes/api.socket-token.ts"),
  route("api/report", "routes/api.report.ts"),
  route("api/bug-report", "routes/api.bug-report.ts"),
  // The script front door (VRIP-08).
  route("api/mod/:action", "routes/api.mod.$action.ts"),
] satisfies RouteConfig;
