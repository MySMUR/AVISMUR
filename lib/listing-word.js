/*
 * Listing d'inventaire au format Word (.docx), à partir du modèle institutionnel du CH d'Avignon
 * (modele_documents_divers_word_portrait.dotx).
 *
 * - Reprend tel quel l'en-tête (logos, bandeau service/référence/version/date/page), les styles
 *   (Titre 1…) et le pied de page du modèle : seuls les champs sont renseignés.
 * - Chaque sous-contenant de niveau 1 commence sur une nouvelle page (option `sautNiveau1`).
 * - Les sous-contenants suivants deviennent des lignes de tableau : nom à gauche, articles à droite
 *   (liste à coches ✓), comme dans l'inventaire du sac bleu 2e intention (SAM KIT 02 D).
 * - Tout est éditable dans Word (vrais styles, vraies listes, vrais tableaux).
 *
 * Utilisation (navigateur ou Node) :
 *   const octets = await ListingWord.generer({ JSZip, modele, contenants, racineId, ... });
 *
 * Aucune dépendance autre que JSZip : fonctionne hors ligne une fois JSZip et le modèle en cache.
 */
(function (racine, fabrique) {
  if (typeof module === 'object' && module.exports) module.exports = fabrique();
  else racine.ListingWord = fabrique();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const BLEU = '143D8A';
  const BLEU_CLAIR = 'DCE4F2';
  const LARGEUR = 10204; // largeur utile (twips) : A4 11906 - 2 × 851
  const COL_GAUCHE = 3200;
  const COL_DROITE = LARGEUR - COL_GAUCHE;
  const NUM_COCHE = 20; // numId / abstractNumId ajoutés à numbering.xml
  const PROFONDEUR_MAX = 12;

  const echapper = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  // ---------------------------------------------------------------- XML : briques

  function run(texte, o = {}) {
    const rpr = `${o.gras ? '<w:b/>' : ''}${o.italique ? '<w:i/>' : ''}${o.majuscules ? '<w:caps/>' : ''}`
      + `${o.couleur ? `<w:color w:val="${o.couleur}"/>` : ''}<w:sz w:val="${o.taille || 20}"/><w:szCs w:val="${o.taille || 20}"/>`;
    return `<w:r><w:rPr>${rpr}</w:rPr><w:t xml:space="preserve">${echapper(texte)}</w:t></w:r>`;
  }

  function paragraphe(runs, { jc = 'left', suivant = false, avant = 0, apres = 0, puce = false, saut = false, style = '' } = {}) {
    const ppr = `${style ? `<w:pStyle w:val="${style}"/>` : ''}${suivant ? '<w:keepNext/>' : ''}${saut ? '<w:pageBreakBefore/>' : ''}`
      + `${puce ? `<w:numPr><w:ilvl w:val="0"/><w:numId w:val="${NUM_COCHE}"/></w:numPr>` : ''}`
      + `<w:spacing w:before="${avant}" w:after="${apres}"/><w:jc w:val="${jc}"/>`;
    return `<w:p><w:pPr>${ppr}</w:pPr>${runs}</w:p>`;
  }

  function cellule(contenu, { largeur, fond = '', span = 0, centre = true } = {}) {
    return `<w:tc><w:tcPr><w:tcW w:w="${largeur}" w:type="dxa"/>${span ? `<w:gridSpan w:val="${span}"/>` : ''}`
      + `${fond ? `<w:shd w:val="clear" w:color="auto" w:fill="${fond}"/>` : ''}${centre ? '<w:vAlign w:val="center"/>' : ''}</w:tcPr>${contenu}</w:tc>`;
  }

  const ligne = (cellules, { entete = false } = {}) => `<w:tr><w:trPr><w:cantSplit/></w:trPr>${cellules}</w:tr>`;

  /** Ligne de titre de section (sur toute la largeur) : niveau 0 = bleu plein, plus profond = bleu clair. */
  function ligneSection(titre, niveau) {
    const plein = niveau === 0;
    return ligne(cellule(paragraphe(run(titre, { gras: true, majuscules: true, couleur: plein ? 'FFFFFF' : BLEU }),
      { jc: 'center', suivant: true, avant: 40, apres: 40 }),
    { largeur: LARGEUR, span: 2, fond: plein ? BLEU : BLEU_CLAIR }));
  }

  /** Une ligne « nom du contenant | articles ». */
  function ligneContenu(nom, sousTitre, paragraphesArticles) {
    const gauche = paragraphe(run(nom, { gras: true, couleur: BLEU }), { jc: 'center', avant: 40, apres: sousTitre ? 0 : 40 })
      + (sousTitre ? paragraphe(run(sousTitre, { italique: true, couleur: '595959', taille: 16 }), { jc: 'center', apres: 40 }) : '');
    return ligne(cellule(gauche, { largeur: COL_GAUCHE }) + cellule(paragraphesArticles, { largeur: COL_DROITE, centre: false }));
  }

  function tableau(lignes) {
    const bord = (nom, sz) => `<w:${nom} w:val="single" w:sz="${sz}" w:space="0" w:color="${BLEU}"/>`;
    return `<w:tbl><w:tblPr><w:tblStyle w:val="Grilledutableau"/><w:tblW w:w="${LARGEUR}" w:type="dxa"/>`
      + `<w:tblBorders>${bord('top', 12)}${bord('left', 12)}${bord('bottom', 12)}${bord('right', 12)}${bord('insideH', 4)}${bord('insideV', 4)}</w:tblBorders>`
      + `<w:tblLayout w:type="fixed"/><w:tblCellMar><w:top w:w="28" w:type="dxa"/><w:left w:w="100" w:type="dxa"/><w:bottom w:w="28" w:type="dxa"/><w:right w:w="100" w:type="dxa"/></w:tblCellMar>`
      + `<w:tblLook w:val="04A0" w:firstRow="1" w:lastRow="0" w:firstColumn="1" w:lastColumn="0" w:noHBand="0" w:noVBand="1"/></w:tblPr>`
      + `<w:tblGrid><w:gridCol w:w="${COL_GAUCHE}"/><w:gridCol w:w="${COL_DROITE}"/></w:tblGrid>${lignes.join('')}</w:tbl>`;
  }

  // ---------------------------------------------------------------- Données : vue d'un contenant

  /**
   * Transforme la structure de l'application en arbre prêt à imprimer.
   *   contenants : { id: { id, parent, nom, ordre, scellable, articles, emplacement, supprime, … } }
   * Un emplacement sans occupant (ex. « Sac rouge » attendant un exemplaire du type) est développé avec le
   * contenu de l'inventaire type attendu (si un seul), sinon signalé « au choix ».
   */
  function construireArbre(contenants, racineId, o) {
    const exclus = new Set(o.exclus || []);
    const nomPropre = (n) => (o.nomContenant ? o.nomContenant(n) : n);
    const actifs = Object.values(contenants).filter((c) => c && !c.supprime);
    const parId = (id) => contenants[id] && !contenants[id].supprime ? contenants[id] : null;
    const enfantsDe = o.enfantsDe ? (id) => o.enfantsDe(id) : (id) => actifs.filter((c) => (c.parent || '') === (id || ''))
      .sort((a, b) => (a.ordre || 0) - (b.ordre || 0) || String(a.nom).localeCompare(String(b.nom), 'fr'));

    function vue(c, nomImpose, profondeur, vus) {
      if (profondeur > PROFONDEUR_MAX || vus.has(c.id)) return null;
      if (profondeur > 0 && exclus.has(c.id)) return null; // décoché dans la fenêtre de choix : lui et ce qu'il contient
      const suite = new Set(vus).add(c.id);
      let source = c; // contenant dont on lit le contenu
      let note = '';
      const fils = enfantsDe(c.id);
      if (c.emplacement && !fils.length) {
        const modeles = (c.emplacement.modeles || [c.emplacement.modele]).map(parId).filter(Boolean);
        if (modeles.length === 1) source = modeles[0];
        else if (modeles.length > 1) note = `Au choix : ${modeles.map((m) => m.nom).join(' / ')}`;
      }
      // Exemplaire sans contenu propre (ex. tiroir d'un type immobile) : il lit celui de son inventaire type.
      if (source === c && !fils.length && !(c.articles || []).length && c.source && parId(c.source)) source = parId(c.source);
      const articles = (o.articlesDe ? o.articlesDe(source) : source.articles) || [];
      const enfants = (source === c ? fils : enfantsDe(source.id))
        .map((x) => vue(x, '', profondeur + 1, suite)).filter(Boolean);
      return { id: c.id, nom: nomPropre(nomImpose || c.nom), scellable: !!(c.scellable || source.scellable), articles, enfants, note };
    }
    const r = parId(racineId);
    if (!r) throw new Error('Contenant introuvable');
    return vue(r, '', 0, new Set());
  }

  function paragraphesArticles(articles, libelle) {
    if (!articles.length) return paragraphe(run('Aucun article', { italique: true, couleur: '7F7F7F' }), { apres: 0 });
    return articles.map((a) => {
      const t = libelle(a);
      if (a.separateur) return paragraphe(run(t.texte, { gras: true }), { suivant: true, avant: 40 });
      return paragraphe(run(t.texte), { puce: true });
    }).join('');
  }

  /** Lignes d'un contenant et de ses descendants (niveau 2 et au-delà de l'arbre). */
  function lignesDe(v, niveau, libelle, lignes) {
    if (v.enfants.length) {
      lignes.push(ligneSection(v.nom, niveau));
      if (v.articles.length) lignes.push(ligneContenu('Contenu direct', '', paragraphesArticles(v.articles, libelle)));
      v.enfants.forEach((e) => lignesDe(e, niveau + 1, libelle, lignes));
    } else {
      const sous = [v.scellable ? 'scellable' : '', v.note].filter(Boolean).join(' · ');
      lignes.push(ligneContenu(v.nom, sous, v.note && !v.articles.length ? paragraphe(run(v.note, { italique: true, couleur: '595959' })) : paragraphesArticles(v.articles, libelle)));
    }
  }

  // ---------------------------------------------------------------- Libellé d'un article

  function libelleParDefaut(a) {
    if (a.separateur) return { texte: a.nom || '' };
    const nom = a.nom || a.ref || '';
    if (a.controle) {
      const attente = a.attendu ? ` (${a.attendu})` : (a.min != null || a.max != null ? ` (${a.min != null ? a.min : ''} – ${a.max != null ? a.max : ''}${a.unite ? ` ${a.unite}` : ''})` : '');
      return { texte: `${nom}${attente} : ${a.controle === 'oui' ? 'Oui / Non' : '………………'}` };
    }
    return { texte: a.quantite && String(a.quantite) !== '1' ? `${a.quantite} × ${nom}` : (a.quantite ? `1 × ${nom}` : nom) };
  }

  // ---------------------------------------------------------------- Corps du document

  function corps(arbre, o) {
    const libelle = (a) => (o.libelleArticle ? o.libelleArticle(a) : libelleParDefaut(a));
    const saut = o.sautNiveau1 !== false;
    const parts = [];
    parts.push(paragraphe(run(`${arbre.nom}`, { gras: true, couleur: BLEU, taille: 24 })
      + run(` — listing d'inventaire généré le ${o.dateTexte}${o.auteurTexte ? ` par ${o.auteurTexte}` : ''} depuis MySMUR.`), { apres: 120 }));

    let premier = true;
    if (arbre.articles.length) {
      parts.push(paragraphe(run(`${arbre.nom} — contenu direct`, { majuscules: true }), { style: 'Titre1', suivant: true, avant: 0 }));
      parts.push(tableau([ligneContenu('Contenu direct', '', paragraphesArticles(arbre.articles, libelle))]));
      premier = false;
    }
    arbre.enfants.forEach((n1) => {
      parts.push(paragraphe(run(n1.nom, { majuscules: true, gras: true, couleur: BLEU, taille: 28 }) + (n1.scellable ? run('  (scellable)', { italique: true, couleur: '595959', taille: 18 }) : ''),
        { style: 'Titre1', jc: 'center', suivant: true, saut: saut && !premier, avant: premier ? 0 : 0 }));
      const lignes = [];
      if (n1.enfants.length) {
        if (n1.articles.length) lignes.push(ligneContenu('Contenu direct', '', paragraphesArticles(n1.articles, libelle)));
        n1.enfants.forEach((e) => lignesDe(e, 0, libelle, lignes));
      } else {
        lignes.push(ligneContenu(n1.nom, n1.note, n1.note && !n1.articles.length ? paragraphe(run(n1.note, { italique: true })) : paragraphesArticles(n1.articles, libelle)));
      }
      parts.push(tableau(lignes));
      // Un paragraphe entre deux tableaux évite leur fusion (et clôt le document proprement).
      parts.push(paragraphe('', { apres: 0 }));
      premier = false;
    });
    if (!arbre.enfants.length && !arbre.articles.length) {
      parts.push(paragraphe(run('Ce contenant est vide.', { italique: true })));
    }
    return parts.join('');
  }

  // ---------------------------------------------------------------- Modèle : champs, numérotation, styles

  const formatDate = (d) => `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;

  /** Remplace le texte d'un contrôle de contenu (repéré par son alias) : 1er texte = valeur, les autres vidés. */
  function remplirChamp(xml, alias, valeur) {
    const repere = `<w:alias w:val="${alias}"/>`;
    const i = xml.indexOf(repere);
    if (i < 0) return xml;
    const debut = xml.indexOf('<w:sdtContent>', i);
    const fin = xml.indexOf('</w:sdtContent>', debut);
    if (debut < 0 || fin < 0) return xml;
    let premier = true;
    const contenu = xml.slice(debut, fin).replace(/<w:t(?: [^>]*)?>[^<]*<\/w:t>/g, () => {
      if (premier) { premier = false; return `<w:t xml:space="preserve">${echapper(valeur)}</w:t>`; }
      return '<w:t></w:t>';
    });
    return xml.slice(0, debut) + contenu + xml.slice(fin);
  }

  /** Coche la n-ième case à cocher (0 = CHA, 1 = CHICL) de l'en-tête de première page. */
  function cocher(xml, rang) {
    let n = -1;
    return xml.replace(/<w:sdt><w:sdtPr>(?:(?!<\/w:sdtPr>).)*?<w14:checkbox>.*?<\/w:sdt>/gs, (bloc) => {
      n += 1;
      if (n !== rang) return bloc;
      return bloc.replace('<w14:checked w14:val="0"/>', '<w14:checked w14:val="1"/>').replace('<w:t>☐</w:t>', '<w:t>☒</w:t>');
    });
  }

  function renseignerEntete(xml, c) {
    let x = xml;
    x = remplirChamp(x, 'Titre ', c.titre);
    x = remplirChamp(x, 'Adresse société', c.reference);
    x = remplirChamp(x, 'Télécopie société', c.version);
    x = remplirChamp(x, 'Date de publication', c.dateTexte);
    x = x.replace(/w:fullDate="[^"]*"/g, `w:fullDate="${c.dateIso}"`);
    x = x.replace('<w:t>SERVICE OU THEME</w:t>', `<w:t>${echapper(c.service)}</w:t>`);
    x = cocher(x, c.etablissement === 'CHICL' ? 1 : 0);
    return x;
  }

  function ajouterNumerotation(xml) {
    if (xml.includes(`w:abstractNumId="${NUM_COCHE}"`)) return xml;
    const abstrait = `<w:abstractNum w:abstractNumId="${NUM_COCHE}"><w:multiLevelType w:val="singleLevel"/>`
      + `<w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val=""/><w:lvlJc w:val="left"/>`
      + `<w:pPr><w:ind w:left="340" w:hanging="340"/></w:pPr><w:rPr><w:rFonts w:ascii="Wingdings" w:hAnsi="Wingdings" w:hint="default"/><w:color w:val="${BLEU}"/></w:rPr></w:lvl></w:abstractNum>`;
    const i = xml.indexOf('<w:num ');
    const avecAbstrait = i < 0 ? xml : xml.slice(0, i) + abstrait + xml.slice(i);
    return avecAbstrait.replace('</w:numbering>', `<w:num w:numId="${NUM_COCHE}"><w:abstractNumId w:val="${NUM_COCHE}"/></w:num></w:numbering>`);
  }

  // ---------------------------------------------------------------- API

  /**
   * options :
   *   JSZip        bibliothèque JSZip (sinon la globale)
   *   modele       contenu du .dotx (ArrayBuffer / Uint8Array / Buffer)
   *   contenants   structure.contenants de l'application
   *   racineId     contenant à lister (ex. F26)
   *   titre        titre du document (défaut : « INVENTAIRE <nom> »)
   *   reference    référence documentaire (défaut : « INV-<nom> »)
   *   version      n° de version (défaut : « 1 »)
   *   service      bandeau du haut (défaut : « SAMU – SMUR 84 »)
   *   etablissement 'CHA' (défaut) ou 'CHICL'
   *   date         Date (défaut : aujourd'hui)
   *   auteurTexte  facultatif, ex. initiales de l'agent
   *   sautNiveau1  true par défaut : saut de page avant chaque sous-contenant de niveau 1
   *   libelleArticle(a) → { texte }  (permet d'utiliser nomArticle() de l'application : nom de la base, quantité…)
   *   exclus       identifiants des sous-contenants à ne pas inclure (avec ce qu'ils contiennent)
   *   nomContenant(nom) → nom affiché d'un contenant (ex. sans son numéro)
   *   enfantsDe(id) → sous-contenants triés d'un contenant (défaut : d'après `parent` et `ordre`)
   *   articlesDe(c) → articles du contenant (si le contenu d'un exemplaire vient de son inventaire type)
   * Renvoie un Uint8Array (le .docx).
   */
  async function generer(options) {
    const JSZip = options.JSZip || (typeof self !== 'undefined' ? self.JSZip : null);
    if (!JSZip) throw new Error('JSZip manquant');
    const arbre = construireArbre(options.contenants, options.racineId, options);
    const date = options.date || new Date();
    const dateTexte = formatDate(date);
    const champs = {
      titre: String(options.titre || `INVENTAIRE ${arbre.nom}`).toUpperCase(),
      reference: options.reference || `INV-${arbre.nom}`.toUpperCase().replace(/\s+/g, '-'),
      version: String(options.version || '1'),
      service: options.service || 'SAMU – SMUR 84',
      etablissement: options.etablissement || 'CHA',
      dateTexte,
      dateIso: `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}T00:00:00Z`,
    };
    const zip = await JSZip.loadAsync(options.modele);
    const lire = (p) => zip.file(p).async('string');

    // Modèle (.dotx) -> document (.docx)
    let types = await lire('[Content_Types].xml');
    types = types.replace('wordprocessingml.template.main+xml', 'wordprocessingml.document.main+xml');
    zip.file('[Content_Types].xml', types);

    // Corps : tout remplacer sauf la mise en page (sectPr : marges, en-têtes, pieds de page, première page différente)
    let doc = await lire('word/document.xml');
    const debut = doc.indexOf('<w:body>') + '<w:body>'.length;
    const sect = doc.lastIndexOf('<w:sectPr');
    doc = doc.slice(0, debut) + corps(arbre, { ...options, dateTexte }) + doc.slice(sect);
    zip.file('word/document.xml', doc);

    // En-têtes (page 1 et suivantes)
    for (const f of ['word/header2.xml', 'word/header3.xml']) zip.file(f, renseignerEntete(await lire(f), champs));
    // Valeurs liées aux contrôles de contenu : Word les relit ici à l'ouverture
    let liees = await lire('customXml/item1.xml');
    liees = liees.replace(/<PublishDate>[^<]*<\/PublishDate>/, `<PublishDate>${champs.dateIso.replace('Z', '')}</PublishDate>`)
      .replace(/<CompanyAddress>[^<]*<\/CompanyAddress>/, `<CompanyAddress>${echapper(champs.reference)}</CompanyAddress>`)
      .replace(/<CompanyFax>[^<]*<\/CompanyFax>/, `<CompanyFax>${echapper(champs.version)}</CompanyFax>`);
    zip.file('customXml/item1.xml', liees);
    let core = await lire('docProps/core.xml');
    core = core.replace(/<dc:title>[^<]*<\/dc:title>/, `<dc:title>${echapper(champs.titre)}</dc:title>`)
      .replace(/<dc:creator>[^<]*<\/dc:creator>/, '<dc:creator>MySMUR</dc:creator>')
      .replace(/<cp:lastModifiedBy>[^<]*<\/cp:lastModifiedBy>/, '<cp:lastModifiedBy>MySMUR</cp:lastModifiedBy>')
      .replace(/(<dcterms:created [^>]*>)[^<]*/, `$1${champs.dateIso}`).replace(/(<dcterms:modified [^>]*>)[^<]*/, `$1${champs.dateIso}`)
      .replace(/<cp:contentStatus>[^<]*<\/cp:contentStatus>/, '');
    zip.file('docProps/core.xml', core);

    // Liste à coches ✓
    zip.file('word/numbering.xml', ajouterNumerotation(await lire('word/numbering.xml')));

    return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
  }

  return { generer, construireArbre, libelleParDefaut };
}));
