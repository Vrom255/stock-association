"use strict";

window.StockSession = (() => {
  let configuration = null;
  let storage = null;
  let currentSession = null;
  let selectedPersistentMode = false;
  let refreshPromise = null;

  function configure(url, publicKey) {
    configuration = {
      url: url.replace(/\/+$/, ""),
      publicKey,
      storageKey: `association-session-v2:${url.replace(/\/+$/, "")}`
    };
  }

  function checkConfigured() {
    if (!configuration) {
      throw new Error("Le gestionnaire de session n’est pas configuré.");
    }
  }

  function normalize(data) {
    if (
      !data?.access_token ||
      !data?.refresh_token ||
      !data?.user?.id
    ) {
      throw new Error("Réponse de connexion inattendue.");
    }

    const expiry = Number(
      data.expires_at ??
      Math.floor(Date.now() / 1000) + Number(data.expires_in)
    );

    if (!Number.isFinite(expiry)) {
      throw new Error("Expiration de session invalide.");
    }

    return {
      token: data.access_token,
      refresh: data.refresh_token,
      expiry,
      userId: data.user.id
    };
  }

  function read(targetStorage) {
    const value = targetStorage.getItem(configuration.storageKey);

    if (!value) {
      return null;
    }

    const session = JSON.parse(value);

    if (
      typeof session?.token !== "string" ||
      typeof session?.refresh !== "string" ||
      typeof session?.userId !== "string" ||
      !Number.isFinite(session.expiry)
    ) {
      throw new Error(
        "La session enregistrée est invalide. Reconnectez-vous."
      );
    }

    return session;
  }

  function store(session) {
    currentSession = session;

    if (!storage) {
      return session;
    }

    try {
      storage.setItem(
        configuration.storageKey,
        JSON.stringify(session)
      );
    } catch {
      // Ne pas laisser un ancien jeton après une rotation.
      try {
        storage.removeItem(configuration.storageKey);
      } catch {
        // Le navigateur peut interdire entièrement le stockage.
      }

      storage = null;
    }

    return session;
  }

  function choose(persistent) {
    checkConfigured();

    if (persistent && !navigator.locks) {
      throw new Error(
        "La connexion durable nécessite un navigateur récent. " +
        "Décochez Rester connecté pour continuer."
      );
    }

    selectedPersistentMode = Boolean(persistent);

    const target = selectedPersistentMode
      ? localStorage
      : sessionStorage;

    // Vérifier la disponibilité avant la connexion.
    const testKey = `${configuration.storageKey}:test`;

    try {
      target.setItem(testKey, "1");
      target.removeItem(testKey);
    } catch {
      throw new Error(
        "Le navigateur interdit le stockage de session. " +
        "Vérifiez ses paramètres de confidentialité."
      );
    }
  }

  function accept(data) {
    checkConfigured();

    const session = normalize(data);
    const target = selectedPersistentMode
      ? localStorage
      : sessionStorage;

    // Une seule session conservée par cette version de l'application.
    localStorage.removeItem(configuration.storageKey);
    sessionStorage.removeItem(configuration.storageKey);

    storage = target;
    return store(session);
  }

  function restore() {
    checkConfigured();

    let session = read(sessionStorage);
    let target = sessionStorage;

    if (!session) {
      session = read(localStorage);
      target = localStorage;
    }

    if (!session) {
      return null;
    }

    if (target === localStorage && !navigator.locks) {
      throw new Error(
        "Cette connexion durable nécessite un navigateur récent. " +
        "Reconnectez-vous sans cocher Rester connecté."
      );
    }

    storage = target;
    currentSession = session;
    selectedPersistentMode = target === localStorage;

    return session;
  }

  async function withLock(action) {
    if (navigator.locks) {
      return navigator.locks.request(
        `${configuration.storageKey}:refresh`,
        action
      );
    }

    return action();
  }

  async function refresh(session) {
    let response;
    let data;

    try {
      response = await fetch(
        `${configuration.url}/auth/v1/token?grant_type=refresh_token`,
        {
          method: "POST",
          headers: {
            apikey: configuration.publicKey,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            refresh_token: session.refresh
          }),
          cache: "no-store",
          signal: AbortSignal.timeout(15000)
        }
      );

      if (response.ok) {
        data = await response.json();
      }
    } catch {
      throw new Error(
        "Le renouvellement de la session n’a pas pu être confirmé. " +
        "Vérifiez Internet avant de réessayer."
      );
    }

    if (!response.ok) {
      if (response.status === 429) {
        throw new Error(
          "Trop de demandes de connexion. Attendez avant de réessayer."
        );
      }

      throw new Error(
        "La session n’a pas pu être renouvelée. " +
        "Une reconnexion peut être nécessaire."
      );
    }

    return normalize(data);
  }

  async function ensure(applicationSession) {
    checkConfigured();

    if (!applicationSession) {
      throw new Error("Connectez-vous pour continuer.");
    }

    if (refreshPromise) {
      return refreshPromise;
    }

    refreshPromise = withLock(async () => {
      let session = currentSession ?? applicationSession;

      if (storage) {
        const saved = read(storage);

        if (
          !saved ||
          saved.userId !== applicationSession.userId
        ) {
          throw new Error(
            "La connexion a changé dans le navigateur. " +
            "Ne validez pas d’opération avant de vous reconnecter."
          );
        }

        session = saved;
      }

      if (session.userId !== applicationSession.userId) {
        throw new Error("Le compte connecté a changé.");
      }

      if (session.expiry > Date.now() / 1000 + 90) {
        currentSession = session;
        return session;
      }

      const renewed = await refresh(session);
      return store(renewed);
    });

    try {
      return await refreshPromise;
    } finally {
      refreshPromise = null;
    }
  }

  function clear() {
    if (configuration) {
      for (const target of [localStorage, sessionStorage]) {
        try {
          const saved = read(target);

          // Ne pas effacer un autre compte connecté dans un autre onglet.
          if (
            saved &&
            currentSession &&
            saved.userId === currentSession.userId
          ) {
            target.removeItem(configuration.storageKey);
          }
        } catch {
          // Effacer seulement le stockage actuellement utilisé
          // lorsque son contenu ne peut plus être lu.
          if (target === storage) {
            try {
              target.removeItem(configuration.storageKey);
            } catch {
              // La session en mémoire sera tout de même effacée.
            }
          }
        }
      }
    }

    storage = null;
    currentSession = null;
  }

  return {
    configure,
    choose,
    accept,
    restore,
    ensure,
    clear
  };
})();