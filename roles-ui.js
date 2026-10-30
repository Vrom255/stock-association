"use strict";

// Ce fichier complète l'interface actuelle.
// Les autorisations réelles restent contrôlées par Supabase.

(() => {
  const roleLabels = {
    admin: "Administrateur",
    logistics: "Responsable logistique",
    member: "Membre"
  };

  function canManageStock() {
    return (
      state.member?.role === "admin" ||
      state.member?.role === "logistics"
    );
  }

  function updateRoleInterface() {
    const allowed = canManageStock();

    $("#new-article").hidden = !allowed;
    $("#new-event").hidden = !allowed;
    $("#new-event-list").hidden = !allowed;

    // Les cartes sont recréées lors de la recherche et de
    // l'actualisation : appliquer également les droits ici.
    for (const item of document.querySelectorAll(
      "#stock-list button"
    )) {
      if (item.textContent.trim() === "+ Lot / réception") {
        item.hidden = !allowed;
      }
    }

    if (state.member) {
      const roleLabel =
        roleLabels[state.member.role] ?? "Rôle inconnu";

      $("#identity").textContent =
        `${state.member.display_name} — ${roleLabel}`;
    }

    // Vérifier aussi les options d'un formulaire déjà ouvert.
    const operationSelect = $("#edit-kind");

    if (operationSelect && !allowed) {
      for (const option of [...operationSelect.options]) {
        if (
          option.value === "adjustment_in" ||
          option.value === "adjustment_out"
        ) {
          option.remove();
        }
      }
    }
  }

  // Remplacer la liste des opérations proposées au panier.
  allowedKinds = function (item) {
    const options = [
      ["purchase", kinds.purchase],
      ["consumption", kinds.consumption],
      ["loss", kinds.loss],
      ["breakage", kinds.breakage]
    ];

    if (item.category === "equipment") {
      options.push(["loan", kinds.loan]);

      if (context() === "event") {
        options.push(["internal_use", kinds.internal_use]);
      }
    }

    if (context() === "inventory" && canManageStock()) {
      options.push(
        ["adjustment_in", kinds.adjustment_in],
        ["adjustment_out", kinds.adjustment_out]
      );
    }

    return options;
  };

  // Appliquer les droits après chaque reconstruction du stock.
  const previousRenderStock = renderStock;

  renderStock = function () {
    previousRenderStock();
    updateRoleInterface();
  };

  // Appliquer les droits après chaque actualisation complète.
  const previousRender = render;

  render = function () {
    previousRender();
    updateRoleInterface();
  };

  // Le code de connexion renseigne le nom après render().
  // Réappliquer ensuite le libellé complet avec le rôle.
  const previousOpenWorkspace = openWorkspace;

  openWorkspace = async function () {
    await previousOpenWorkspace();
    updateRoleInterface();
  };

  // Relire le rôle lors d'une actualisation :
  // un changement effectué dans Supabase est ainsi pris en compte.
  const previousLoad = load;

  load = async function () {
    const members = await api(
      "/rest/v1/members?select=display_name,role,active" +
      `&user_id=eq.${encodeURIComponent(state.session.userId)}`
    );

    if (
      !Array.isArray(members) ||
      members.length !== 1 ||
      !members[0].active
    ) {
      throw new Error(
        "Ce compte n’est plus autorisé à gérer le stock."
      );
    }

    state.member = members[0];

    await previousLoad();
    updateRoleInterface();
  };

  // Si la connexion a déjà été restaurée, appliquer immédiatement.
  if (state.member) {
    updateRoleInterface();
  }
})();