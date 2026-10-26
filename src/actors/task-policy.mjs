// Policy 1 is persisted by old clients. Its web failures keep their reservation,
// while old API cache hits stay charged. Policy 2 must not change those old jobs.
export const isActiveJob=job=>['running','paused','awaiting-cache'].includes(job?.state);
export const refundsFailure=job=>job.policyVersion===2||job.api||job.kind==='ai';
export const refundsCacheOnly=job=>job.policyVersion===2||!job.api;
export const retriesAutomatically=job=>job.kind==='query'&&(job.api||job.policyVersion===2);
