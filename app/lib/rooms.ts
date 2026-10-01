export const ROOMS = {
  "campus-live": {
    id: "campus-live",
    name: "Campus Live",
    subtitle: "one room, the whole college",
    placeholder: "Say something to the college",
    emptyStateMessage: "One room, the whole college, and an empty screen.",
  },
  placements: {
    id: "placements",
    name: "placements",
    subtitle: "career and internship discussions",
    placeholder: "Say something in #placements",
    emptyStateMessage: "Ask your doubts related to the placement cell, training programs, and interview prep.",
  },
  electives: {
    id: "electives",
    name: "electives",
    subtitle: "course selection and reviews",
    placeholder: "Say something in #electives",
    emptyStateMessage: "Discuss course selections, share subject reviews, and ask for faculty recommendations.",
  },
  hostel: {
    id: "hostel",
    name: "hostel",
    subtitle: "dorm life and campus housing",
    placeholder: "Say something in #hostel",
    emptyStateMessage: "Ask about hostel facilities, dorm life, rules, or find roommates.",
  },
  projects: {
    id: "projects",
    name: "projects",
    subtitle: "collaborate on open source and lab work",
    placeholder: "Say something in #projects",
    emptyStateMessage: "Find team members for your academic projects, discuss lab work, or ask technical queries.",
  },
} as const;

export type RoomId = keyof typeof ROOMS;

export const ROOM_IDS = Object.keys(ROOMS) as RoomId[];

export function isValidRoomId(id: string): id is RoomId {
  return ROOM_IDS.includes(id as RoomId);
}
