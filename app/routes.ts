import { type RouteConfig, index, route } from "@react-router/dev/routes";

export default [
  index("routes/home.tsx"),
  route("room", "routes/room-redirect.tsx"),
  route("room/:roomId", "routes/room.tsx"),
  // Not rendered for a student, and every action re-checks the role server-side.
  route("mod", "routes/mod.tsx"),

  route("api/auth/*", "routes/api.auth.$.ts"),
  route("api/socket-token", "routes/api.socket-token.ts"),
  route("api/report", "routes/api.report.ts"),
  // The script front door (VRIP-08).
  route("api/mod/:action", "routes/api.mod.$action.ts"),
] satisfies RouteConfig;
