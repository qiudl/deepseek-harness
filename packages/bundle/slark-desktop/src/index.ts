/**
 * @deepseek-ai/dsh-slark-desktop — M1 Desktop profile bundle (REQ-20260915-0013).
 *
 * Composes the Slark execution plugins (slark-identity + collaboration-network,
 * with device-client as slark-identity's dependency) into a DSH Host that KEEPS
 * local execution (subprocess/sandbox). Unlike the cloud-cell bundle, it adds no
 * ingress guard and disables no local-execution plugin. Substance is cordis.patch.yml
 * (declared via dsh.bundle.patch); this module carries no runtime API.
 * @module @deepseek-ai/dsh-slark-desktop
 */
export {}
