// Static scanner fixtures; never executed.
import { Blob as NativeBlob } from "node:buffer";
async function responseMethods(response: Response) {
  // ruleid: openclaw.web-fetch-or-media-unbounded-response-read
  await response.text();
  // ruleid: openclaw.web-fetch-or-media-unbounded-response-read
  await response.json();
  // ruleid: openclaw.web-fetch-or-media-unbounded-response-read
  await response.arrayBuffer();
  // ruleid: openclaw.web-fetch-or-media-unbounded-response-read
  await response.blob();
  // ruleid: openclaw.web-fetch-or-media-unbounded-response-read
  await response.bytes();
  // ruleid: openclaw.web-fetch-or-media-unbounded-response-read
  await response.formData();
}

async function localImmutableBlob() {
  const body = new NativeBlob(["small local fixture"]);
  // ok: openclaw.web-fetch-or-media-unbounded-response-read
  await body.text();
}

async function guardedRequestBlob(init: RequestInit, response: Response) {
  const body = init.body;
  if (body instanceof NativeBlob) {
    // ok: openclaw.web-fetch-or-media-unbounded-response-read
    await body.arrayBuffer();
    // ruleid: openclaw.web-fetch-or-media-unbounded-response-read
    await response.text();
  }
}

async function unrelatedGuard(init: RequestInit, response: Response) {
  if (init.body instanceof Blob) {
    const body = response;
    // ruleid: openclaw.web-fetch-or-media-unbounded-response-read
    await body.arrayBuffer();
  }
}

async function reassignedBlob(response: Response) {
  let body: Blob | Response = new Blob(["local"]);
  body = response;
  // ruleid: openclaw.web-fetch-or-media-unbounded-response-read
  await body.text();
}

async function shadowedBlob(Blob: typeof Response) {
  const body = new Blob("unbounded response");
  // ruleid: openclaw.web-fetch-or-media-unbounded-response-read
  await body.text();
}

async function shadowedNativeImport(NativeBlob: typeof Response) {
  const body = new NativeBlob("unbounded response");
  // ruleid: openclaw.web-fetch-or-media-unbounded-response-read
  await body.text();
}

async function mutableGuard(init: RequestInit, response: Response) {
  let body = init.body;
  if (body instanceof NativeBlob) {
    body = response;
    // ruleid: openclaw.web-fetch-or-media-unbounded-response-read
    await body.arrayBuffer();
  }
}

async function differentSnapshotGuard(init: RequestInit) {
  const body = init.body;
  if (init.body instanceof NativeBlob) {
    // ruleid: openclaw.web-fetch-or-media-unbounded-response-read
    await body.arrayBuffer();
  }
}

async function unsafeConstructorInput(response: Response) {
  // ruleid: openclaw.web-fetch-or-media-unbounded-response-read
  const body = new NativeBlob([await response.arrayBuffer()]);
  // ok: openclaw.web-fetch-or-media-unbounded-response-read
  await body.text();
}

async function shadowedGuard(NativeBlob: typeof Response, response: Response) {
  const body = response;
  if (body instanceof NativeBlob) {
    // ruleid: openclaw.web-fetch-or-media-unbounded-response-read
    await body.text();
  }
}

async function shadowedResponse(response: Response) {
  const body = new NativeBlob(["local"]);
  const consume = async (body: Response) => {
    // ruleid: openclaw.web-fetch-or-media-unbounded-response-read
    await body.text();
  };
  await consume(response);
}

async function innerShadowedResponse(response: Response) {
  const body = response;
  if (body instanceof NativeBlob) {
    const consume = async (body: Response) => {
      // ruleid: openclaw.web-fetch-or-media-unbounded-response-read
      await body.arrayBuffer();
    };
    await consume(response);
  }
}

async function outsideGuard(init: RequestInit) {
  const body = init.body;
  if (body instanceof NativeBlob) {
    // ok: openclaw.web-fetch-or-media-unbounded-response-read
    await body.text();
  }
  // ruleid: openclaw.web-fetch-or-media-unbounded-response-read
  await body.arrayBuffer();
}
