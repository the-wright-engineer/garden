/*
 * Copyright (C) 2018-2020 Garden Technologies, Inc. <info@garden.io>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import { ClientAuthToken } from "../db/entities/client-auth-token"
import { LogEntry } from "../logger/log-entry"

/**
 * We make a transaction deleting all existing client auth tokens and creating a new token.
 *
 * This also covers the inconsistent/erroneous case of more than one auth token existing in the local store.
 */
export async function saveAuthToken(token: string, log: LogEntry) {
  try {
    const manager = ClientAuthToken.getConnection().manager
    await manager.transaction(async (transactionalEntityManager) => {
      await transactionalEntityManager.clear(ClientAuthToken)
      await transactionalEntityManager.save(ClientAuthToken, ClientAuthToken.create({ token }))
      log.debug("Saved client auth token to local config db")
    })
  } catch (error) {
    log.error(`An error occurred while saving client auth token to local config db:\n${error.message}`)
  }
}

/**
 * If a persisted client auth token was found, returns it. Returns null otherwise.
 *
 * In the inconsistent/erroneous case of more than one auth token existing in the local store, picks the first auth
 * token and deletes all others.
 */
export async function readAuthToken(log: LogEntry): Promise<string | null> {
  const [tokens, tokenCount] = await ClientAuthToken.findAndCount()

  const token = tokens[0] ? tokens[0].token : null

  if (tokenCount > 1) {
    log.debug("More than one client auth tokens found, clearing up...")
    try {
      await ClientAuthToken.getConnection()
        .createQueryBuilder()
        .delete()
        .from(ClientAuthToken)
        .where("token != :token", { token })
        .execute()
    } catch (error) {
      log.error(`An error occurred while clearing up duplicate client auth tokens:\n${error.message}`)
    }
  }
  log.debug("Retrieved client auth token from local config db")

  return token
}

/**
 * If a persisted client auth token exists, deletes it.
 */
export async function clearAuthToken(log: LogEntry) {
  await ClientAuthToken.getConnection()
    .createQueryBuilder()
    .delete()
    .from(ClientAuthToken)
    .execute()
  log.debug("Cleared persisted auth token (if any)")
}