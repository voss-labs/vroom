/**
 * The rooms this deployment serves (VRIP-12). A fixed list, not a table: there
 * is no room creation, and an id that is not here is refused at the upgrade.
 */

const ROOM_LIST = {
  "campus-live": {
    id: "campus-live",
    name: "Campus Live",
    subtitle: "the whole college, live",
    placeholder: "Say something to the college",
    empty: "The whole college, and an empty screen.",
    starters: [
      "What is happening on campus right now?",
      "Best late-night food spot open today?",
      "Anyone heading to the library right now?",
    ],
  },
  placements: {
    id: "placements",
    name: "Placements",
    subtitle: "companies, rounds, offers",
    placeholder: "Say something in #placements",
    empty:
      "What a company asked, which round it was, what the offer looked like.",
    starters: [
      "Which OA or interview round finished today?",
      "What topics did the latest shortlist test focus on?",
      "How long did results take after the technical interview?",
    ],
  },
  electives: {
    id: "electives",
    name: "Electives",
    subtitle: "which ones are actually manageable",
    placeholder: "Say something in #electives",
    empty:
      "Which elective is worth it, which one is a trap, who teaches it well.",
    starters: [
      "Which open elective has the most practical syllabus?",
      "How heavy is the grading in this semester's humanities electives?",
      "FFCS slot advice: morning vs afternoon lab trade-offs?",
    ],
  },
  hostel: {
    id: "hostel",
    name: "Hostel",
    subtitle: "rooms, rules, roommates",
    placeholder: "Say something in #hostel",
    empty:
      "Hostel facilities, hostel rules, and finding someone to share with.",
    starters: [
      "How is Wi-Fi holding up in your block tonight?",
      "Which mess caterer is worth switching to next month?",
      "Looking for a quiet roommate for next counselling?",
    ],
  },
  projects: {
    id: "projects",
    name: "Projects",
    subtitle: "find people to build with",
    placeholder: "Say something in #projects",
    empty: "Find teammates, ask about lab work, or show what you built.",
    starters: [
      "Looking for 1-2 people to build a weekend side project.",
      "Anyone working with Cloudflare Workers or Rust on campus?",
      "Need a teammate for the upcoming hackathon — what are you building?",
    ],
  },
} as const;

export type RoomId = keyof typeof ROOM_LIST;

export interface RoomMeta {
  id: RoomId;
  name: string;
  subtitle: string;
  placeholder: string;
  empty: string;
  starters: readonly string[];
}

export const ROOMS: Record<RoomId, RoomMeta> = ROOM_LIST;
export const ROOM_IDS = Object.keys(ROOM_LIST) as RoomId[];
export const DEFAULT_ROOM_ID: RoomId = "campus-live";

export function isRoomId(value: unknown): value is RoomId {
  return typeof value === "string" && (ROOM_IDS as string[]).includes(value);
}
