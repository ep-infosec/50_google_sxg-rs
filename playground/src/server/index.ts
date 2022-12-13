/**
 * Copyright 2022 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import assert from 'assert';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

import Fastify from 'fastify';

import {
  CreateSignedExchangeRequest,
  CreateSignedExchangeResponse,
} from '../schema';
import {SubresourceCache} from './cache';
import {fetcher} from './fetcher';
import {fromJwk as createSignerFromJwk} from './signer';
import {WasmResponse, createWorker} from './wasmFunctions';

const wasmBuffer = fs.readFileSync(
  path.resolve(
    __dirname,
    '..',
    '..',
    'cloudflare_worker',
    'pkg',
    'cloudflare_worker_bg.wasm'
  )
);

export const DEFAULT_SXG_CONFIG = `
cert_url_dirname: ".well-known/sxg-certs"
forward_request_headers:
  - user-agent
  - cf-ipcountry
reserved_path: ".sxg"
strip_request_headers: []
strip_response_headers:
  - set-cookie
  - strict-transport-security
  - report-to
validity_url_dirname: ".well-known/sxg-validity"
`;

// Spawns a SXG server that runs in background, and returns a function to stop
// the server.
export async function spawnSxgServer({
  certificatePem,
  crawlerUserAgent,
  privateKeyJwk,
  privateKeyPem,
  sxgConfig,
}: {
  certificatePem: string;
  crawlerUserAgent: string;
  privateKeyJwk: Object;
  privateKeyPem: string;
  sxgConfig?: string;
}) {
  const signer = createSignerFromJwk(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (crypto.webcrypto as any).subtle,
    privateKeyJwk
  );
  const storage = (() => {
    const m = new Map<string, string>();
    return {
      async read(k: string) {
        return m.get(k) ?? null;
      },
      async write(k: string, v: string) {
        m.set(k, v);
      },
    };
  })();
  function createRuntime() {
    return {
      nowInSeconds: Date.now() / 1000,
      storageRead: storage.read,
      storageWrite: storage.write,
      sxgAsn1Signer: undefined,
      sxgRawSigner: signer,
      acmeRawSigner: undefined, // Playground uses self-signed certificate, and does not use ACME.
      fetcher,
    };
  }
  const worker = await createWorker(
    wasmBuffer,
    sxgConfig ?? DEFAULT_SXG_CONFIG,
    [certificatePem]
  );
  const subresourceCache = new SubresourceCache();
  // The list of all SXG generated by the server.
  const sxgList: WasmResponse[] = [];
  // Creates an SXG, and puts it into sxgList.
  // Signs subresources if isTopLevel is true.
  async function createSxgIntoList(
    innerUrl: string,
    certOrigin: string,
    isTopLevel: boolean
  ) {
    let sxgPayload = await fetcher({
      url: innerUrl,
      body: [],
      method: 'Get',
      headers: [['user-agent', crawlerUserAgent]],
    });
    sxgPayload = await worker.processHtml(sxgPayload, {isSxg: true});
    const urlRecorder = subresourceCache.createRecorder();
    // TODO(PR#157): Use `handleRequest` function in `cloudflare_worker/worker/src/index.ts`.
    const sxg = await worker.createSignedExchange(createRuntime(), {
      fallbackUrl: innerUrl,
      certOrigin,
      statusCode: sxgPayload.status,
      payloadHeaders: sxgPayload.headers,
      payloadBody: new Uint8Array(sxgPayload.body),
      skipProcessLink: false,
      headerIntegrityGet: urlRecorder.get,
      headerIntegrityPut: urlRecorder.put,
    });
    const subresourceUrls = isTopLevel
      ? Array.from(urlRecorder.visitedUrls())
      : [];
    const subresourceLinkHeaders = await Promise.all(
      subresourceUrls.map(async subresourceUrl => {
        const subresourceSxg = await createSxgIntoList(
          subresourceUrl,
          certOrigin,
          /*isTopLevel=*/ false
        );
        return `<${subresourceSxg.outerUrl}>;rel="alternate";type="application/signed-exchange;v=b3";anchor="${subresourceUrl}"`;
      })
    );
    if (subresourceLinkHeaders.length > 0) {
      sxg.headers.push(['link', subresourceLinkHeaders.join(',')]);
    }
    sxgList.push(sxg);
    const sxgId = sxgList.length - 1;
    return {
      outerUrl: `https://localhost:8443/sxg/${sxgId}`,
      info: {
        bodySize: sxgPayload.body.length,
        subresourceUrls,
      },
    };
  }

  const fastify = Fastify({
    logger: false,
    https: {
      key: privateKeyPem,
      cert: certificatePem,
    },
  });
  fastify.post('/create-sxg', async (request, reply) => {
    const {innerUrl} = JSON.parse(
      request.body as string
    ) as CreateSignedExchangeRequest;
    let response: CreateSignedExchangeResponse;
    try {
      const sxg = await createSxgIntoList(
        innerUrl,
        `https://${request.hostname}`,
        /*isTopLevel=*/ true
      );
      response = ['Ok', sxg];
    } catch (e) {
      response = ['Err', {message: `${e}`}];
    }
    reply.header('content-type', 'application/json');
    return JSON.stringify(response);
  });
  fastify.get('/.well-known/sxg-certs/*', async (request, reply) => {
    const x = await worker.servePresetContent(
      createRuntime(),
      `https://localhost:8443${request.url}`
    );
    assert(x?.kind === 'direct');
    x.headers.forEach(([k, v]) => reply.header(k, v));
    return Buffer.from(x.body);
  });
  fastify.get('/sxg/:id', async (request, reply) => {
    const params = request.params as {id: string};
    const sxg = sxgList[parseInt(params.id)]!;
    sxg.headers.forEach(([k, v]) => reply.header(k, v));
    return Buffer.from(sxg.body);
  });
  await fastify.listen(8443, '0.0.0.0');
  return async function stopServer() {
    await fastify.close();
  };
}