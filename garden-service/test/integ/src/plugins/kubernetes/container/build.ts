/*
 * Copyright (C) 2018-2020 Garden Technologies, Inc. <info@garden.io>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import { expectError } from "../../../../../helpers"
import { Garden } from "../../../../../../src/garden"
import { ConfigGraph } from "../../../../../../src/config-graph"
import { k8sBuildContainer } from "../../../../../../src/plugins/kubernetes/container/build"
import { PluginContext } from "../../../../../../src/plugin-context"
import { KubernetesProvider } from "../../../../../../src/plugins/kubernetes/config"
import { expect } from "chai"
import { getContainerTestGarden } from "./container"

describe("k8sBuildContainer", () => {
  let garden: Garden
  let graph: ConfigGraph
  let provider: KubernetesProvider
  let ctx: PluginContext

  after(async () => {
    if (garden) {
      await garden.close()
    }
  })

  const init = async (environmentName: string) => {
    garden = await getContainerTestGarden(environmentName)
    graph = await garden.getConfigGraph(garden.log)
    provider = <KubernetesProvider>await garden.resolveProvider("local-kubernetes")
    ctx = garden.getPluginContext(provider)
  }

  context("local mode", () => {
    before(async () => {
      await init("local")
    })

    it("should build a simple container (local only)", async () => {
      const module = await graph.getModule("simple-service")
      await garden.buildDir.syncFromSrc(module, garden.log)

      await k8sBuildContainer({
        ctx,
        log: garden.log,
        module,
      })
    })
  })

  context("cluster-docker mode", () => {
    before(async () => {
      await init("cluster-docker")
    })

    it("should build a simple container", async () => {
      const module = await graph.getModule("simple-service")
      await garden.buildDir.syncFromSrc(module, garden.log)

      await k8sBuildContainer({
        ctx,
        log: garden.log,
        module,
      })
    })

    it("should support pulling from private registries (remote only)", async () => {
      const module = await graph.getModule("private-base")
      await garden.buildDir.syncFromSrc(module, garden.log)

      await k8sBuildContainer({
        ctx,
        log: garden.log,
        module,
      })
    })

    it("should throw if attempting to pull from private registry without access", async () => {
      const module = await graph.getModule("inaccessible-base")
      await garden.buildDir.syncFromSrc(module, garden.log)

      await expectError(
        () =>
          k8sBuildContainer({
            ctx,
            log: garden.log,
            module,
          }),
        (err) => {
          expect(err.message).to.include("pull access denied")
        }
      )
    })

    it("should push to configured deploymentRegistry if specified (remote only)", async () => {
      const module = await graph.getModule("private-base")
      await garden.buildDir.syncFromSrc(module, garden.log)

      await k8sBuildContainer({
        ctx,
        log: garden.log,
        module,
      })
    })
  })

  context("cluster-docker-remote-registry mode", () => {
    before(async () => {
      await init("cluster-docker-remote-registry")
    })

    it("should push to configured deploymentRegistry if specified (remote only)", async () => {
      const module = await graph.getModule("remote-registry-test")
      await garden.buildDir.syncFromSrc(module, garden.log)

      await k8sBuildContainer({
        ctx,
        log: garden.log,
        module,
      })
    })
  })

  context("cluster-docker mode with BuildKit", () => {
    before(async () => {
      await init("cluster-docker-buildkit")
    })

    it("should build a simple container", async () => {
      const module = await graph.getModule("simple-service")
      await garden.buildDir.syncFromSrc(module, garden.log)

      const result = await k8sBuildContainer({
        ctx,
        log: garden.log,
        module,
      })

      // Make sure we're actually using BuildKit
      expect(result.buildLog!).to.include("load build definition from Dockerfile")
    })

    it("should support pulling from private registries (remote only)", async () => {
      const module = await graph.getModule("private-base")
      await garden.buildDir.syncFromSrc(module, garden.log)

      await k8sBuildContainer({
        ctx,
        log: garden.log,
        module,
      })
    })

    it("should throw if attempting to pull from private registry without access", async () => {
      const module = await graph.getModule("inaccessible-base")
      await garden.buildDir.syncFromSrc(module, garden.log)

      await expectError(
        () =>
          k8sBuildContainer({
            ctx,
            log: garden.log,
            module,
          }),
        (err) => {
          expect(err.message).to.include("pull access denied")
        }
      )
    })
  })

  context("kaniko mode", () => {
    before(async () => {
      await init("kaniko")
    })

    it("should build a simple container", async () => {
      const module = await graph.getModule("simple-service")
      await garden.buildDir.syncFromSrc(module, garden.log)

      await k8sBuildContainer({
        ctx,
        log: garden.log,
        module,
      })
    })

    it("should support pulling from private registries (remote only)", async () => {
      const module = await graph.getModule("private-base")
      await garden.buildDir.syncFromSrc(module, garden.log)

      await k8sBuildContainer({
        ctx,
        log: garden.log,
        module,
      })
    })

    it("should throw if attempting to pull from private registry without access", async () => {
      const module = await graph.getModule("inaccessible-base")
      await garden.buildDir.syncFromSrc(module, garden.log)

      await expectError(
        () =>
          k8sBuildContainer({
            ctx,
            log: garden.log,
            module,
          }),
        (err) => {
          expect(err.message).to.include("UNAUTHORIZED")
        }
      )
    })
  })

  context("kaniko-remote-registry mode", () => {
    before(async () => {
      await init("kaniko-remote-registry")
    })

    it("should push to configured deploymentRegistry if specified (remote only)", async () => {
      const module = await graph.getModule("remote-registry-test")
      await garden.buildDir.syncFromSrc(module, garden.log)

      await k8sBuildContainer({
        ctx,
        log: garden.log,
        module,
      })
    })
  })
})
