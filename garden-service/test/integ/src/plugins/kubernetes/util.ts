/*
 * Copyright (C) 2018-2020 Garden Technologies, Inc. <info@garden.io>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import { expect } from "chai"
import { flatten, find, first } from "lodash"
import stripAnsi from "strip-ansi"
import { TestGarden, expectError } from "../../../../helpers"
import { ConfigGraph } from "../../../../../src/config-graph"
import { Provider } from "../../../../../src/config/provider"
import { DeployTask } from "../../../../../src/tasks/deploy"
import { KubeApi } from "../../../../../src/plugins/kubernetes/api"
import { KubernetesConfig } from "../../../../../src/plugins/kubernetes/config"
import {
  getWorkloadPods,
  getServiceResourceSpec,
  findServiceResource,
  getResourceContainer,
} from "../../../../../src/plugins/kubernetes/util"
import { createWorkloadManifest } from "../../../../../src/plugins/kubernetes/container/deployment"
import { emptyRuntimeContext } from "../../../../../src/runtime-context"
import { PluginContext } from "../../../../../src/plugin-context"
import { getHelmTestGarden } from "./helm/common"
import { deline } from "../../../../../src/util/string"
import { getBaseModule, getChartResources } from "../../../../../src/plugins/kubernetes/helm/common"
import { buildHelmModule } from "../../../../../src/plugins/kubernetes/helm/build"
import { HotReloadableResource } from "../../../../../src/plugins/kubernetes/hot-reload"
import { LogEntry } from "../../../../../src/logger/log-entry"
import { BuildTask } from "../../../../../src/tasks/build"
import { getContainerTestGarden } from "./container/container"

describe("util", () => {
  let helmGarden: TestGarden
  let helmGraph: ConfigGraph
  let ctx: PluginContext
  let log: LogEntry

  before(async () => {
    helmGarden = await getHelmTestGarden()
    const provider = await helmGarden.resolveProvider("local-kubernetes")
    ctx = helmGarden.getPluginContext(provider)
    log = helmGarden.log
    helmGraph = await helmGarden.getConfigGraph(helmGarden.log)
    await buildModules()
  })

  beforeEach(async () => {
    helmGraph = await helmGarden.getConfigGraph(helmGarden.log)
  })

  after(async () => {
    return helmGarden && helmGarden.close()
  })

  async function buildModules() {
    const modules = await helmGraph.getModules()
    const tasks = modules.map(
      (module) => new BuildTask({ garden: helmGarden, log, module, force: false, _guard: true })
    )
    const results = await helmGarden.processTasks(tasks)

    const err = first(Object.values(results).map((r) => r && r.error))

    if (err) {
      throw err
    }
  }

  // TODO: Add more test cases
  describe("getWorkloadPods", () => {
    it("should return workload pods", async () => {
      const garden = await getContainerTestGarden("local")

      try {
        const graph = await garden.getConfigGraph(garden.log)
        const provider = (await garden.resolveProvider("local-kubernetes")) as Provider<KubernetesConfig>
        const api = await KubeApi.factory(garden.log, provider)

        const service = await graph.getService("simple-service")

        const deployTask = new DeployTask({
          force: false,
          forceBuild: false,
          garden,
          graph,
          log: garden.log,
          service,
        })

        const resource = await createWorkloadManifest({
          api,
          provider,
          service,
          runtimeContext: emptyRuntimeContext,
          namespace: "container",
          enableHotReload: false,
          log: garden.log,
          production: false,
        })
        await garden.processTasks([deployTask], { throwOnError: true })

        const pods = await getWorkloadPods(api, "container", resource)
        const services = flatten(pods.map((pod) => pod.spec.containers.map((container) => container.name)))
        expect(services).to.eql(["simple-service"])
      } finally {
        await garden.close()
      }
    })
  })

  describe("getServiceResourceSpec", () => {
    it("should return the spec on the given module if it has no base module", async () => {
      const module = await helmGraph.getModule("api")
      expect(getServiceResourceSpec(module, undefined)).to.eql(module.spec.serviceResource)
    })

    it("should return the spec on the base module if there is none on the module", async () => {
      const module = await helmGraph.getModule("api")
      const baseModule = await helmGraph.getModule("postgres")
      module.spec.base = "postgres"
      delete module.spec.serviceResource
      module.buildDependencies = { postgres: baseModule }
      expect(getServiceResourceSpec(module, baseModule)).to.eql(baseModule.spec.serviceResource)
    })

    it("should merge the specs if both module and base have specs", async () => {
      const module = await helmGraph.getModule("api")
      const baseModule = await helmGraph.getModule("postgres")
      module.spec.base = "postgres"
      module.buildDependencies = { postgres: baseModule }
      expect(getServiceResourceSpec(module, baseModule)).to.eql({
        containerModule: "api-image",
        kind: "Deployment",
        name: "postgres",
      })
    })

    it("should throw if there is no base module and the module has no serviceResource spec", async () => {
      const module = await helmGraph.getModule("api")
      delete module.spec.serviceResource
      await expectError(
        () => getServiceResourceSpec(module, undefined),
        (err) =>
          expect(stripAnsi(err.message)).to.equal(
            deline`helm module api doesn't specify a serviceResource in its configuration.
          You must specify a resource in the module config in order to use certain Garden features,
          such as hot reloading, tasks and tests.`
          )
      )
    })

    it("should throw if there is a base module but neither module has a spec", async () => {
      const module = await helmGraph.getModule("api")
      const baseModule = await helmGraph.getModule("postgres")
      module.spec.base = "postgres"
      module.buildDependencies = { postgres: baseModule }
      delete module.spec.serviceResource
      delete baseModule.spec.serviceResource
      await expectError(
        () => getServiceResourceSpec(module, getBaseModule(module)),
        (err) =>
          expect(stripAnsi(err.message)).to.equal(
            deline`helm module api doesn't specify a serviceResource in its configuration.
          You must specify a resource in the module config in order to use certain Garden features,
          such as hot reloading, tasks and tests.`
          )
      )
    })
  })

  describe("findServiceResource", () => {
    it("should return the resource specified by serviceResource", async () => {
      const module = await helmGraph.getModule("api")
      const manifests = await getChartResources(ctx, module, false, log)
      const result = await findServiceResource({
        ctx,
        log,
        module,
        manifests,
        baseModule: undefined,
      })
      const expected = find(manifests, (r) => r.kind === "Deployment")
      expect(result).to.eql(expected)
    })

    it("should throw if no resourceSpec or serviceResource is specified", async () => {
      const module = await helmGraph.getModule("api")
      const manifests = await getChartResources(ctx, module, false, log)
      delete module.spec.serviceResource
      await expectError(
        () => findServiceResource({ ctx, log, module, manifests, baseModule: undefined }),
        (err) =>
          expect(stripAnsi(err.message)).to.equal(
            deline`helm module api doesn't specify a serviceResource in its configuration.
          You must specify a resource in the module config in order to use certain Garden features,
          such as hot reloading, tasks and tests.`
          )
      )
    })

    it("should throw if no resource of the specified kind is in the chart", async () => {
      const module = await helmGraph.getModule("api")
      const manifests = await getChartResources(ctx, module, false, log)
      const resourceSpec = {
        ...module.spec.serviceResource,
        kind: "DaemonSet",
      }
      await expectError(
        () =>
          findServiceResource({
            ctx,
            log,
            module,
            manifests,
            resourceSpec,
            baseModule: undefined,
          }),
        (err) => expect(stripAnsi(err.message)).to.equal("helm module api contains no DaemonSets.")
      )
    })

    it("should throw if matching resource is not found by name", async () => {
      const module = await helmGraph.getModule("api")
      const manifests = await getChartResources(ctx, module, false, log)
      const resourceSpec = {
        ...module.spec.serviceResource,
        name: "foo",
      }
      await expectError(
        () =>
          findServiceResource({
            ctx,
            log,
            module,
            manifests,
            resourceSpec,
            baseModule: undefined,
          }),
        (err) => expect(stripAnsi(err.message)).to.equal("helm module api does not contain specified Deployment foo")
      )
    })

    it("should throw if no name is specified and multiple resources are matched", async () => {
      const module = await helmGraph.getModule("api")
      const manifests = await getChartResources(ctx, module, false, log)
      const deployment = find(manifests, (r) => r.kind === "Deployment")
      manifests.push(deployment!)
      await expectError(
        () => findServiceResource({ ctx, log, module, manifests, baseModule: undefined }),
        (err) =>
          expect(stripAnsi(err.message)).to.equal(deline`
          helm module api contains multiple Deployments.
          You must specify serviceResource.name in the module config in order to
          identify the correct Deployment to use.`)
      )
    })

    it("should resolve template string for resource name", async () => {
      const module = await helmGraph.getModule("postgres")
      await buildHelmModule({ ctx, module, log })
      const manifests = await getChartResources(ctx, module, false, log)
      module.spec.serviceResource.name = `{{ template "postgresql.master.fullname" . }}`
      const result = await findServiceResource({
        ctx,
        log,
        module,
        manifests,
        baseModule: undefined,
      })
      const expected = find(manifests, (r) => r.kind === "StatefulSet")
      expect(result).to.eql(expected)
    })
  })

  describe("getResourceContainer", () => {
    async function getDeployment() {
      const module = await helmGraph.getModule("api")
      const manifests = await getChartResources(ctx, module, false, log)
      return <HotReloadableResource>find(manifests, (r) => r.kind === "Deployment")!
    }

    it("should get the first container on the resource if no name is specified", async () => {
      const deployment = await getDeployment()
      const expected = deployment.spec.template.spec.containers[0]
      expect(getResourceContainer(deployment)).to.equal(expected)
    })

    it("should pick the container by name if specified", async () => {
      const deployment = await getDeployment()
      const expected = deployment.spec.template.spec.containers[0]
      expect(getResourceContainer(deployment, "api")).to.equal(expected)
    })

    it("should throw if no containers are in resource", async () => {
      const deployment = await getDeployment()
      deployment.spec.template.spec.containers = []
      await expectError(
        () => getResourceContainer(deployment),
        (err) => expect(err.message).to.equal("Deployment api-release has no containers configured.")
      )
    })

    it("should throw if name is specified and no containers match", async () => {
      const deployment = await getDeployment()
      await expectError(
        () => getResourceContainer(deployment, "foo"),
        (err) => expect(err.message).to.equal("Could not find container 'foo' in Deployment 'api-release'")
      )
    })
  })
})
