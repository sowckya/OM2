# OM2 — Product Requirements & Claude Development Guide

**Version:** 1.0  
**Date:** 24 October 2026  
**Status:** Agreed design baseline; implementation not started

## 1. Purpose and status

OM2 (Operation Million Mark) is a planned content operations platform for a network of X and Instagram accounts. Goal: aspire to 1 million combined daily views across the network; this is a target, not a guaranteed result. This document records agreed requirements and initial technical choices. No implementation has been completed yet.

## 2. People, roles, and account ownership

The planned network comprises 100 X accounts and 100 Instagram accounts, operated by 50 individuals called Omkars. Each Omkar creates, owns and operates two X accounts and two Instagram accounts, including account access and manual publishing. The core team is called Millionaires. Millionaires use individual admin logins with role-based permissions (recommended; final admin-permission details remain to be confirmed) to manage strategy, content, approval, distribution and tracking. OM2 must never require storing Omkars' X passwords. Build X workflows first; Instagram is a later phase.

## 3. Product principles

One web application with distinct Millionaires admin and Omkar experiences. Admin UI is desktop-friendly; Omkar UI is mobile-first and installable as a PWA. Each X account has a distinct editorial identity. Avoid repetitive, copied, misleading or inauthentically amplified content. Human approval is required before release. Release to Omkar is not the same as publishing on X. Maintain traceable assignment, review and publication statuses.

## 4. Account management and Content DNA

Admin can view, search, filter, add, edit and assign all X accounts to Omkars. Per-account fields: X handle, assigned Omkar, primary theme, allowed secondary themes, language (English, Telugu, Tinglish, mixed), tone, target audience, writing style, allowed formats, additional AI instructions, daily posting target and optional sample writing. Themes can be configured as (a) primary theme plus occasional related topics, (b) percentage-weighted themes across a period, or (c) flexible AI-selected mix from allowed themes. Admin can override theme, topic, language or format per post. Preserve content history when Content DNA changes. Each account can be edited independently.

## 5. AI Content Studio

Support three creation methods: AI Generate, Manual Writing and AI-Assisted Writing. AI generation supports one account, selected accounts, theme-based groups or all accounts. Two modes: Quick Generate (one candidate per publishing slot) and Generate Options (three genuinely different candidates per slot); neither is mandatory. Admin sets the number of post slots per account and optional generation instructions. Each generation uses the account's Content DNA, recent formats and content history. Drafts are stored, editable and grouped by account and post slot. Admin may regenerate one weak draft without rerunning the entire batch. Track generation history and estimated AI usage costs.

## 6. Freshness, content memory and inspiration

Store both account-level and network-wide generated, rejected, approved and published content history. Detect exact duplicates and semantically similar ideas, not merely repeated wording. Flag close matches and generate fresh angles; do not guarantee perfect uniqueness. Vary questions, observations, opinions, humour, one-liners, 3–4 line reflections, occasional poetic writing, timely topics and factual content according to account identity. Trend/inspiration intelligence is a later phase: study publicly available successful content for formats and patterns, not for copying; use verifiable sources for current events, attribute where appropriate and fact-check claims. Never invent personal experiences or fabricate engagement.

## 7. Content Library, approval and calendar

Library filters by account, theme, source, status and date. Millionaires can edit, reject, approve individually or approve in bulk with warnings. Recheck similarity and factual flags after edits. Only approved content is eligible for release. Calendar shows scheduled assignments and per-account content coverage. Coverage tracker compares daily targets with approved/scheduled assignments; 'Generate Remaining Content' addresses failed generation, rejections or target changes. This is a tracker within the calendar, not a separate large module. Retain audit history of who changed or approved content.

## 8. Scheduling and distribution

Admin can push approved assignments immediately, schedule specific dates/times or spread target publishing times across an admin-selected window. Default behavior is Option B: approved posts become visible to Omkars in advance, with a clearly shown target time to publish. Admin may configure how early posts become visible (e.g., previous evening, 2 hours before or on approval), and may optionally hide time-sensitive content until release. All times must be stored timezone-aware; present local time, initially IST. Admin can edit/cancel before release with appropriate status handling. Scheduling controls assignment availability and intended manual publication time; OM2 does not automatically post to X.

## 9. Omkar mobile experience

One login per Omkar. Default home screen is a combined chronological feed for both assigned X accounts, with account filters. Each post shows intended @handle, content, target posting time and status. Tapping 'Post on X' opens an X Web Intent URL with URL-encoded text prefilled. On phones it may open the app or browser depending on platform settings. Omkar must check the active X account and tap X's final Post button. Simple Web Intent does not attach media, ensure correct account selection or prove publishing. After posting, Omkar returns to OM2 and submits the published X status URL. Validate URL shape, then mark Submitted (not Verified Published); verify separately through admin review or a future authorized integration. Show progress, submission history, reminders, notifications and Report an Issue. PWA and mobile browser behavior must be tested on Android and iOS.

## 10. Notifications and tracking

Notify Omkars when content is assigned or available and around scheduled times, subject to notification permissions. Support configurable overdue reminders and admin visibility into pending work. Track distinct statuses such as Draft, Needs Review, Approved, Scheduled, Available to Omkar, Submitted, Verified Published, Rejected and Cancelled. Track opened composer separately from published confirmation. Preserve published content and corrections history. Analytics and Omkar compensation/incentives are future design phases; avoid treating unverified manual metrics as verified analytics.

## 11. Initial technology stack

Frontend: React + TypeScript + Vite. UI: Tailwind CSS + shadcn/ui. Backend: Python Django + Django REST Framework. Database: PostgreSQL. AI: Anthropic Claude API (Claude Code is the development assistant; the API is a separate integration). Similarity: PostgreSQL pgvector when content-memory features are implemented. Background scheduling: Celery + Redis when needed. Auth: Django-based role permissions with secure sessions/tokens chosen during implementation. Mobile: responsive PWA. Hosting direction: Vercel frontend; backend hosting to be decided. Local development first. Initial repository layout: frontend/ and backend/ in one repository. Do not install all optional infrastructure on day one.

## 12. Implementation order

1. Create repository and minimal frontend/backend scaffolds. 2. Configure PostgreSQL, authentication, roles and basic account management. 3. Implement Account DNA and Omkar assignment. 4. Build AI/manual content creation and content memory. 5. Build editorial review, library, calendar and coverage. 6. Add scheduled assignment distribution, notifications and background jobs. 7. Build mobile Omkar feed, X Web Intent, URL submission and verification workflow. 8. Test end-to-end with a small pilot (e.g., 5 Omkars / 10 X accounts). 9. Deploy and monitor. 10. Design analytics, Instagram integration and compensation later. Build and verify one small step at a time.

## 13. Engineering instructions for Claude Code

Work incrementally. Do not implement the entire platform from this document in one pass. Before each change, summarize the specific step and files to touch. Keep frontend and backend responsibilities clear. Make minimal, reversible changes; avoid unrelated refactors. Never hardcode credentials or API keys; use environment variables and .env.example. Implement role-based authorization server-side, not only UI hiding. Provide migrations, tests and clear run commands for each completed step. Ask when a product decision is missing. Do not claim an X post was published solely because the composer opened or a URL was entered. Never build automated mass posting or engagement manipulation into the initial product. Preserve user-provided editorial boundaries and platform compliance.

## 14. Open decisions and out of scope

Still to decide: exact admin permission levels, detailed database schema, notification provider, how/when to validate X URLs, media-post workflow, backend hosting, analytics data sources, Instagram workflows, compensation calculations, and exact deployment/operational budgets. Account lists, handles, Omkar identities and per-account DNA will be supplied later. Current documentation is a baseline, not an instruction to code every feature immediately.

