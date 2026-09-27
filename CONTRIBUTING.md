# Contributing to V Rooms

V Rooms is built by VOSS Labs and by students who are not in VOSS. The second
group is the point. Most of what v1 deliberately does not do is on the issue
list so that someone can pick it up and ship it under their own name.

New to open source? Start with
[voss-labs/first-contributions](https://github.com/voss-labs/first-contributions),
then come back.

Open issues are titled by area ([Frontend], [API], [Database], [Testing]) with
a matching label. Start with `good first issue`, and send one pull request per
Part.

## Getting it running

Node 20+, a Cloudflare account (free plan is enough), a Neon project, and a V
Auth client. See the Quick start in `README.md`.

```
npm install
cp .env.example .env
cp .env .dev.vars
npm run db:push
npm run db:migrate
npm run dev
```

You do not need production credentials. Make your own Neon project and register
your own V Auth dev client; ask in the issue if you need a hand.

## Before you write code

Read `AGENTS.md`. It is short, and it carries the constraints that are easy to
break by accident. Then read `.preset/PRODUCT.md` for what v1 is and is not.

The `/vrips/` folder holds the decisions and the reasoning behind them. If you
are about to change something in an area a VRIP covers, read that VRIP first.

## Three rules that are not style preferences

1. **The email and the V Auth account id never leave the server.** They are not
   in the app token, not in the Worker, not in the Durable Object, and not in
   anything a loader serialises to the browser. Exactly one module resolves a
   handle to a person: `app/lib/identity.server.ts`. If you find yourself
   importing the `user` table anywhere else, stop.

2. **Every moderator action re-checks the role on the server.** Hiding a link is
   presentation, not access control. A loader check is not enough if the action
   does not check too.

3. **A reveal is always bound to a report.** The database enforces it — an audit
   row claiming a reveal with no report attached is rejected outright. Do not
   route around it.

## When you need a VRIP

Write one — copy the format of an existing file in `/vrips/` — before changing:
the auth chain, the data model, the realtime transport, anything touching the
identity mapping, or moderation policy.

Do not write one for a bug fix, a UI tweak, or a single-file refactor.

The point is that a proposal gets argued in a document, where changes are cheap,
instead of in a rejected pull request, where they are not.

## House rules

- Files 200 to 400 lines. Split when bigger.
- No emojis anywhere: code, comments, docs, commit messages.
- Comments only where the logic is not self-evident. One line, not a paragraph.
- Mobile-first from 320px. Touch targets at least 44 by 44 CSS pixels.
- Every user-facing flow has loading, error and empty states. The empty state of
  Campus Live matters more here than in most products.
- Tests cover the happy path and the error paths.

## Before you open a pull request

```
npm run typecheck
npm run format
npm test
npm run build
```

CI runs all of these. A green run is the floor, not the verdict — several real
bugs in this repo were found by opening a browser, not by a check.

## Security

Do not open a public issue for a vulnerability, especially anything touching the
identity mapping or the moderator role. Mail the maintainers instead.
