# Agent Note: Desktop personal model text

Status: implemented

English | [中文](2026-09-19-desktop-personal-model-text.zh.md)

## Problem

Slark Desktop needs a small text entry point to the model and API Key already maintained in a local DSH Profile. Copying the credential into Slark or sending personal input through a Slark daemon would add another credential owner and make DSH availability depend on that daemon.

## Decision

The Desktop Main process opens a separate authenticated Host connection for each request. A fresh Account proof opens a connection-owned lease; the Host accepts `profile.model_text` only for a verified connected Account Profile, checks that lease before and after generation, and cancels work when the connection closes. A Profile worker reads its current default model and credential service, performs one bounded text generation without tools or a Session, and returns only provider, model, and answer text. A random Host-owned token authorizes the worker's private loopback endpoint; the browser never receives it.

## Alternatives considered

Sharing the visible Profile view connection would make cancellation affect the user's DSH page. Calling the worker through the browser session would give browser content access to the model request. Storing a second API Key in Slark would require duplicate lifecycle and revocation rules.

## Consequences

The entry point requires an online Account Profile and a configured default model. Each request has an 8 KiB input limit, a 16 KiB answer limit, and a 60-second worker limit. Provider messages and credential values stay inside the Profile worker. The protocol, worker route, Host authorization, and cancellation have focused tests.
