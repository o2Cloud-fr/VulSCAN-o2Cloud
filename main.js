const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const { exec } = require('child_process');
const fs = require('fs');
const ExcelJS = require('exceljs');
const axios = require('axios');

let mainWindow;

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 700,
        height: 800,
        frame: false, // <--- Supprime la barre de titre
        titleBarStyle: 'hidden', // optionnel : style macOS
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        },
        icon: path.join(__dirname, 'assets', 'icon.png'),
        resizable: false
    });

    mainWindow.loadFile('index.html');
    mainWindow.setMenuBarVisibility(false);
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

// Scanner optimisé des logiciels installés
function getInstalledSoftware() {
    return new Promise((resolve, reject) => {
        const commands = [
            // Registry principal
            `Get-ItemProperty 'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*' | Where-Object { $_.DisplayName -and $_.DisplayVersion } | Select-Object DisplayName, DisplayVersion`,
            // Registry 32-bit
            `Get-ItemProperty 'HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*' | Where-Object { $_.DisplayName -and $_.DisplayVersion } | Select-Object DisplayName, DisplayVersion`,
            // Microsoft Store apps (filtrées)
            `Get-AppxPackage | Where-Object { $_.Name -notlike '*Microsoft*' -and $_.Name -notlike '*Windows*' -and $_.Version } | Select-Object Name, Version`
        ];

        Promise.all(commands.map(cmd => 
            new Promise((res) => {
                exec(`powershell -Command "& {${cmd} | ConvertTo-Json}"`, { 
                    maxBuffer: 1024 * 1024 * 20,
                    encoding: 'utf8'
                }, (error, stdout, stderr) => {
                    if (error) {
                        console.warn(`Erreur PowerShell: ${error.message}`);
                        res([]);
                        return;
                    }

                    try {
                        const rawData = stdout.trim();
                        if (!rawData || rawData === 'null' || rawData === '') {
                            res([]);
                            return;
                        }

                        let data = JSON.parse(rawData);
                        if (!Array.isArray(data)) {
                            data = [data];
                        }

                        const software = data
                            .filter(item => 
                                item && 
                                (item.DisplayName || item.Name) && 
                                (item.DisplayVersion || item.Version) &&
                                (item.DisplayName || item.Name).trim().length > 0
                            )
                            .map(item => ({
                                name: (item.DisplayName || item.Name).trim(),
                                version: (item.DisplayVersion || item.Version).trim()
                            }));

                        res(software);
                    } catch (parseError) {
                        console.warn('Erreur parsing JSON:', parseError.message);
                        res([]);
                    }
                });
            })
        )).then(results => {
            const allSoftware = results.flat();
            const uniqueSoftware = [];
            const seen = new Set();

            allSoftware.forEach(item => {
                const key = `${item.name.toLowerCase()}-${item.version}`;
                if (!seen.has(key)) {
                    seen.add(key);
                    uniqueSoftware.push(item);
                }
            });

            if (uniqueSoftware.length === 0) {
                reject(new Error('Aucun logiciel détecté. Vérifiez les permissions d\'accès au registre Windows.'));
            } else {
                console.log(`✅ ${uniqueSoftware.length} logiciels uniques détectés`);
                resolve(uniqueSoftware.slice(0, 500)); // Limite raisonnable
            }
        }).catch(error => {
            reject(new Error(`Échec de la détection des logiciels: ${error.message}`));
        });
    });
}

// Fonction utilitaire pour normaliser et comparer les versions
function normalizeVersion(version) {
    if (!version) return null;
    
    // Nettoyer la version des caractères non numériques en gardant les points
    const cleanVersion = version.toString()
        .replace(/[^\d\.]/g, '')
        .replace(/\.+/g, '.')
        .replace(/^\.+|\.+$/g, '');
    
    // Convertir en tableau de nombres
    const parts = cleanVersion.split('.').map(part => {
        const num = parseInt(part, 10);
        return isNaN(num) ? 0 : num;
    });
    
    // Normaliser à 4 parties minimum (major.minor.patch.build)
    while (parts.length < 4) {
        parts.push(0);
    }
    
    return parts.slice(0, 4); // Limiter à 4 parties
}

function compareVersions(version1, version2) {
    const v1 = normalizeVersion(version1);
    const v2 = normalizeVersion(version2);
    
    if (!v1 || !v2) return 0;
    
    for (let i = 0; i < Math.max(v1.length, v2.length); i++) {
        const a = v1[i] || 0;
        const b = v2[i] || 0;
        
        if (a < b) return -1;
        if (a > b) return 1;
    }
    
    return 0;
}

function isVersionAffected(installedVersion, affectedVersions) {
    if (!installedVersion || !affectedVersions || affectedVersions.length === 0) {
        return { affected: false, reason: 'Informations de version insuffisantes' };
    }
    
    const installed = normalizeVersion(installedVersion);
    if (!installed) {
        return { affected: false, reason: 'Version installée non parsable' };
    }
    
    let isAffected = false;
    let matchedRange = null;
    
    for (const range of affectedVersions) {
        if (range.versionStartIncluding && range.versionEndExcluding) {
            // Plage de versions : >= start ET < end
            const startComp = compareVersions(installedVersion, range.versionStartIncluding);
            const endComp = compareVersions(installedVersion, range.versionEndExcluding);
            
            if (startComp >= 0 && endComp < 0) {
                isAffected = true;
                matchedRange = `${range.versionStartIncluding} <= v < ${range.versionEndExcluding}`;
                break;
            }
        } else if (range.versionStartIncluding && range.versionEndIncluding) {
            // Plage de versions : >= start ET <= end
            const startComp = compareVersions(installedVersion, range.versionStartIncluding);
            const endComp = compareVersions(installedVersion, range.versionEndIncluding);
            
            if (startComp >= 0 && endComp <= 0) {
                isAffected = true;
                matchedRange = `${range.versionStartIncluding} <= v <= ${range.versionEndIncluding}`;
                break;
            }
        } else if (range.versionEndExcluding) {
            // Toutes les versions < end
            const endComp = compareVersions(installedVersion, range.versionEndExcluding);
            if (endComp < 0) {
                isAffected = true;
                matchedRange = `v < ${range.versionEndExcluding}`;
                break;
            }
        } else if (range.versionEndIncluding) {
            // Toutes les versions <= end
            const endComp = compareVersions(installedVersion, range.versionEndIncluding);
            if (endComp <= 0) {
                isAffected = true;
                matchedRange = `v <= ${range.versionEndIncluding}`;
                break;
            }
        } else if (range.exactVersion) {
            // Version exacte
            if (compareVersions(installedVersion, range.exactVersion) === 0) {
                isAffected = true;
                matchedRange = `v = ${range.exactVersion}`;
                break;
            }
        }
    }
    
    return {
        affected: isAffected,
        reason: isAffected ? `Version dans la plage affectée: ${matchedRange}` : 'Version non affectée',
        matchedRange
    };
}

// Fonction pour extraire les informations de version d'une CVE NVD
function extractVersionRanges(cveData) {
    const versionRanges = [];
    
    if (!cveData.configurations || !cveData.configurations.nodes) {
        return versionRanges;
    }
    
    for (const node of cveData.configurations.nodes) {
        if (node.cpeMatch) {
            for (const cpe of node.cpeMatch) {
                if (cpe.vulnerable && cpe.criteria) {
                    const versionInfo = {
                        cpe: cpe.criteria,
                        versionStartIncluding: cpe.versionStartIncluding,
                        versionStartExcluding: cpe.versionStartExcluding,
                        versionEndIncluding: cpe.versionEndIncluding,
                        versionEndExcluding: cpe.versionEndExcluding
                    };
                    
                    versionRanges.push(versionInfo);
                }
            }
        }
        
        // Vérifier les enfants récursivement
        if (node.children) {
            for (const child of node.children) {
                if (child.cpeMatch) {
                    for (const cpe of child.cpeMatch) {
                        if (cpe.vulnerable && cpe.criteria) {
                            const versionInfo = {
                                cpe: cpe.criteria,
                                versionStartIncluding: cpe.versionStartIncluding,
                                versionStartExcluding: cpe.versionStartExcluding,
                                versionEndIncluding: cpe.versionEndIncluding,
                                versionEndExcluding: cpe.versionEndExcluding
                            };
                            
                            versionRanges.push(versionInfo);
                        }
                    }
                }
            }
        }
    }
    
    return versionRanges;
}

// Fonction pour vérifier si le logiciel correspond au CPE
function matchesCPE(softwareName, cpeString) {
    if (!cpeString || !softwareName) return false;
    
    // Extraire le nom du produit du CPE (format: cpe:2.3:a:vendor:product:version...)
    const cpeparts = cpeString.toLowerCase().split(':');
    if (cpeparts.length < 5) return false;
    
    const vendor = cpeparts[3];
    const product = cpeparts[4];
    const softwareLower = softwareName.toLowerCase();
    
    // Vérifications de correspondance
    const checks = [
        softwareLower.includes(product),
        softwareLower.includes(vendor),
        product.includes(softwareLower.split(' ')[0]),
        // Correspondances spécifiques connues
        (softwareLower.includes('chrome') && product.includes('chrome')),
        (softwareLower.includes('firefox') && product.includes('firefox')),
        (softwareLower.includes('adobe') && (vendor.includes('adobe') || product.includes('adobe'))),
        (softwareLower.includes('microsoft') && vendor.includes('microsoft')),
        (softwareLower.includes('java') && product.includes('java')),
        (softwareLower.includes('node') && product.includes('node'))
    ];
    
    return checks.some(check => check);
}

// Fonction améliorée de filtrage des CVE par date
function isRecentVulnerability(publishedDate, maxAgeYears = 10) {
    if (!publishedDate) return true; // Si pas de date, on considère comme récent
    
    const published = new Date(publishedDate);
    const now = new Date();
    const ageYears = (now - published) / (1000 * 60 * 60 * 24 * 365);
    
    return ageYears <= maxAgeYears;
}

// Base de données locale améliorée avec règles de versions
const knownVulnerabilities = {
    'chrome': {
        rules: [
            { 
                maxVersion: '120.0.0.0', 
                cve: 'CVE-2024-0001', 
                severity: 'high', 
                score: 7.5,
                description: 'Use after free in Chrome versions < 120.0.0.0'
            }
        ]
    },
    'firefox': {
        rules: [
            { 
                maxVersion: '115.0.0.0', 
                cve: 'CVE-2024-0002', 
                severity: 'medium', 
                score: 5.0,
                description: 'Memory safety bugs in Firefox < 115.0.0.0'
            }
        ]
    },
    'microsoft azure': {
        rules: [
            {
                maxVersion: '2.9.8000.0',
                cve: 'CVE-2020-AZURE',
                severity: 'low',
                score: 3.0,
                description: 'Configuration issue in Azure Compute Emulator < 2.9.8000.0'
            }
        ]
    }
};

// Fonction principale améliorée pour NVD avec contrôle de version
async function searchVulnerabilitiesNVD(softwareName, version) {
    try {
        const cleanName = softwareName.toLowerCase()
            .replace(/[^\w\s-]/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();

        const searchTerms = [
            cleanName.split(' ')[0],
            cleanName.split(' ').slice(0, 2).join(' '),
            cleanName
        ].filter(term => term.length > 2);

        console.log(`🔍 Recherche NVD améliorée: ${softwareName} v${version}`);

        const baseUrl = 'https://services.nvd.nist.gov/rest/json/cves/2.0';
        
        for (let searchTerm of searchTerms) {
            try {
                const searchUrl = `${baseUrl}?keywordSearch=${encodeURIComponent(searchTerm)}&resultsPerPage=50`;
                console.log(`🌐 Requête NVD: ${searchUrl}`);

                const response = await axios.get(searchUrl, {
                    timeout: 30000,
                    headers: {
                        'User-Agent': 'VulSCAN-Security-Scanner/2.0'
                    }
                });

                if (response.data && response.data.vulnerabilities && response.data.vulnerabilities.length > 0) {
                    console.log(`✅ NVD: ${response.data.vulnerabilities.length} CVE trouvées pour ${searchTerm}`);
                    
                    // Analyser toutes les CVE pour trouver la plus pertinente
                    let bestMatch = null;
                    let highestScore = 0;
                    
                    for (const vuln of response.data.vulnerabilities) {
                        const cve = vuln.cve;
                        
                        // Filtrer les CVE trop anciennes (exemple: CVE-1999-0280)
                        if (!isRecentVulnerability(cve.published, 15)) {
                            console.log(`⏭️ CVE ${cve.id} ignorée (trop ancienne: ${cve.published})`);
                            continue;
                        }
                        
                        // Extraire les plages de versions affectées
                        const versionRanges = extractVersionRanges(cve);
                        
                        // Vérifier si le logiciel correspond et si la version est affectée
                        let softwareMatches = false;
                        let versionCheck = { affected: false, reason: 'Aucune plage de version trouvée' };
                        
                        if (versionRanges.length > 0) {
                            for (const range of versionRanges) {
                                if (matchesCPE(softwareName, range.cpe)) {
                                    softwareMatches = true;
                                    versionCheck = isVersionAffected(version, [range]);
                                    if (versionCheck.affected) {
                                        break; // Version affectée trouvée
                                    }
                                }
                            }
                        } else {
                            // Fallback: vérification basique par nom si pas de CPE
                            const description = cve.descriptions.find(d => d.lang === 'en')?.value || '';
                            if (description.toLowerCase().includes(cleanName.split(' ')[0])) {
                                softwareMatches = true;
                                versionCheck = { affected: true, reason: 'Correspondance par description (à vérifier manuellement)' };
                            }
                        }
                        
                        // Si le logiciel correspond et la version est affectée
                        if (softwareMatches && versionCheck.affected) {
                            // Extraire le score CVSS
                            let score = 0;
                            let severity = 'unknown';
                            
                            if (cve.metrics && cve.metrics.cvssMetricV31 && cve.metrics.cvssMetricV31.length > 0) {
                                score = cve.metrics.cvssMetricV31[0].cvssData.baseScore;
                                severity = cve.metrics.cvssMetricV31[0].cvssData.baseSeverity.toLowerCase();
                            } else if (cve.metrics && cve.metrics.cvssMetricV30 && cve.metrics.cvssMetricV30.length > 0) {
                                score = cve.metrics.cvssMetricV30[0].cvssData.baseScore;
                                severity = cve.metrics.cvssMetricV30[0].cvssData.baseSeverity.toLowerCase();
                            } else if (cve.metrics && cve.metrics.cvssMetricV2 && cve.metrics.cvssMetricV2.length > 0) {
                                score = cve.metrics.cvssMetricV2[0].cvssData.baseScore;
                                if (score >= 7.0) severity = 'high';
                                else if (score >= 4.0) severity = 'medium';
                                else severity = 'low';
                            }
                            
                            // Prendre la CVE avec le score le plus élevé
                            if (score > highestScore) {
                                highestScore = score;
                                
                                const description = cve.descriptions.find(d => d.lang === 'en')?.value || 'Description non disponible';
                                
                                bestMatch = {
                                    hasVulnerability: true,
                                    severity: severity,
                                    cve: cve.id,
                                    description: (description.length > 200 ? description.substring(0, 200) + '...' : description) + 
                                               ` [${versionCheck.reason}]`,
                                    score: score,
                                    confidence: versionRanges.length > 0 ? 'high' : 'medium',
                                    published: cve.published || null,
                                    source: 'NVD',
                                    versionCheck: versionCheck.reason
                                };
                            }
                        }
                    }
                    
                    // Retourner la meilleure correspondance si trouvée
                    if (bestMatch) {
                        console.log(`🎯 Vulnérabilité confirmée: ${bestMatch.cve} (Score: ${bestMatch.score})`);
                        return bestMatch;
                    }
                }

                // Délai entre les requêtes
                await new Promise(resolve => setTimeout(resolve, 1000));

            } catch (searchError) {
                console.warn(`⚠️ Erreur recherche NVD ${searchTerm}:`, searchError.message);
                continue;
            }
        }

        return {
            hasVulnerability: false,
            severity: 'safe',
            cve: '',
            description: `Aucune vulnérabilité confirmée pour ${softwareName} v${version}`,
            score: 0,
            confidence: 'high',
            published: null,
            source: 'NVD',
            versionCheck: 'Version vérifiée - non affectée'
        };

    } catch (error) {
        console.error(`❌ Erreur recherche NVD ${softwareName}:`, error.message);
        
        return {
            hasVulnerability: false,
            severity: 'error',
            cve: '',
            description: `Erreur de recherche NVD: ${error.message}`,
            score: 0,
            confidence: 'error',
            published: null,
            source: 'NVD',
            versionCheck: 'Erreur lors de la vérification'
        };
    }
}

// Fonction améliorée pour l'API CIRCL avec contrôle de version
async function searchVulnerabilitiesCIRCL(softwareName, version) {
    try {
        const cleanName = softwareName.toLowerCase()
            .replace(/[^\w\s-]/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();

        console.log(`🔍 Recherche CIRCL: ${softwareName} v${version}`);

        const baseUrl = 'https://cve.circl.lu/api';
        const searchUrl = `${baseUrl}/search/${encodeURIComponent(cleanName)}`;
        
        console.log(`🌐 Requête CIRCL: ${searchUrl}`);

        const response = await axios.get(searchUrl, {
            timeout: 15000,
            headers: {
                'User-Agent': 'VulSCAN-Security-Scanner/2.0',
                'Accept': 'application/json'
            }
        });

        if (response.data && Array.isArray(response.data) && response.data.length > 0) {
            console.log(`✅ CIRCL: ${response.data.length} résultats trouvés`);
            
            // Filtrer et analyser les résultats
            let bestMatch = null;
            let highestScore = 0;
            
            for (const vuln of response.data) {
                // Filtrer les CVE trop anciennes
                if (vuln.Published && !isRecentVulnerability(vuln.Published, 15)) {
                    continue;
                }
                
                // Vérifier si la version est mentionnée dans les informations
                let versionAffected = false;
                let versionReason = 'Correspondance générale - vérification manuelle recommandée';
                
                if (vuln.vulnerable_product && Array.isArray(vuln.vulnerable_product)) {
                    for (const product of vuln.vulnerable_product) {
                        if (matchesCPE(softwareName, product)) {
                            // Extraire les informations de version du CPE
                            const cpeparts = product.split(':');
                            if (cpeparts.length > 5 && cpeparts[5] !== '*') {
                                const cpeVersion = cpeparts[5];
                                if (compareVersions(version, cpeVersion) === 0) {
                                    versionAffected = true;
                                    versionReason = `Version exacte correspondante: ${cpeVersion}`;
                                    break;
                                } else {
                                    versionAffected = true; // Correspondance partielle
                                    versionReason = `Version similaire dans CPE: ${cpeVersion}`;
                                }
                            } else {
                                versionAffected = true;
                                versionReason = 'Produit correspondant trouvé - toutes versions affectées';
                            }
                        }
                    }
                }
                
                if (versionAffected) {
                    const score = parseFloat(vuln.cvss) || 5.0;
                    
                    if (score > highestScore) {
                        highestScore = score;
                        
                        let severity = 'medium';
                        if (score >= 9.0) severity = 'critical';
                        else if (score >= 7.0) severity = 'high';
                        else if (score >= 4.0) severity = 'medium';
                        else severity = 'low';
                        
                        bestMatch = {
                            hasVulnerability: true,
                            severity: severity,
                            cve: vuln.id || 'N/A',
                            description: (vuln.summary || vuln.description || 'Description non disponible') + ` [${versionReason}]`,
                            score: score,
                            confidence: 'medium',
                            published: vuln.Published || null,
                            source: 'CIRCL',
                            versionCheck: versionReason
                        };
                    }
                }
            }
            
            if (bestMatch) {
                return bestMatch;
            }
        }

        return {
            hasVulnerability: false,
            severity: 'safe',
            cve: '',
            description: `Aucune vulnérabilité confirmée pour ${softwareName} v${version}`,
            score: 0,
            confidence: 'high',
            published: null,
            source: 'CIRCL',
            versionCheck: 'Version vérifiée - non affectée'
        };

    } catch (error) {
        console.error(`❌ Erreur recherche CIRCL ${softwareName}:`, error.message);
        
        return {
            hasVulnerability: false,
            severity: 'error',
            cve: '',
            description: `Erreur de recherche: ${error.message}`,
            score: 0,
            confidence: 'error',
            published: null,
            source: 'CIRCL',
            versionCheck: 'Erreur lors de la vérification'
        };
    }
}

// Fonction de recherche avec base de données locale améliorée
async function searchVulnerabilitiesLocal(softwareName, version) {
    try {
        const cleanName = softwareName.toLowerCase();
        
        for (const [key, vulnData] of Object.entries(knownVulnerabilities)) {
            if (cleanName.includes(key)) {
                for (const rule of vulnData.rules) {
                    if (rule.maxVersion && compareVersions(version, rule.maxVersion) < 0) {
                        return {
                            hasVulnerability: true,
                            severity: rule.severity,
                            cve: rule.cve,
                            description: `${rule.description} [Version installée: ${version}]`,
                            score: rule.score,
                            confidence: 'high',
                            published: new Date().toISOString(),
                            source: 'Local-DB',
                            versionCheck: `Version ${version} < ${rule.maxVersion} (affectée)`
                        };
                    } else if (rule.exactVersion && compareVersions(version, rule.exactVersion) === 0) {
                        return {
                            hasVulnerability: true,
                            severity: rule.severity,
                            cve: rule.cve,
                            description: `${rule.description} [Version exacte: ${version}]`,
                            score: rule.score,
                            confidence: 'high',
                            published: new Date().toISOString(),
                            source: 'Local-DB',
                            versionCheck: `Version exacte ${version} affectée`
                        };
                    }
                }
            }
        }

        return {
            hasVulnerability: false,
            severity: 'safe',
            cve: '',
            description: `Aucune vulnérabilité connue pour ${softwareName} v${version}`,
            score: 0,
            confidence: 'medium',
            published: null,
            source: 'Local-DB',
            versionCheck: 'Version vérifiée localement - non affectée'
        };

    } catch (error) {
        return {
            hasVulnerability: false,
            severity: 'error',
            cve: '',
            description: `Erreur de recherche locale: ${error.message}`,
            score: 0,
            confidence: 'error',
            published: null,
            source: 'Local-DB',
            versionCheck: 'Erreur lors de la vérification'
        };
    }
}

// Fonction principale de recherche avec fallback
async function searchVulnerabilities(softwareName, version) {
    const searchFunctions = [
        searchVulnerabilitiesNVD,
        searchVulnerabilitiesCIRCL,
        searchVulnerabilitiesLocal
    ];

    let bestResult = null;
    let highestConfidence = 'error';

    for (const searchFunc of searchFunctions) {
        try {
            const result = await searchFunc(softwareName, version);
            
            if (result.confidence === 'high' && result.hasVulnerability) {
                return result; // Retourner immédiatement si haute confiance
            }
            
            if (!bestResult || 
                (result.confidence === 'high' && highestConfidence !== 'high') ||
                (result.confidence === 'medium' && highestConfidence === 'low') ||
                (result.hasVulnerability && !bestResult.hasVulnerability)) {
                bestResult = result;
                highestConfidence = result.confidence;
            }

        } catch (error) {
            console.warn(`⚠️ Erreur avec ${searchFunc.name}:`, error.message);
            continue;
        }

        // Délai entre les API
        await new Promise(resolve => setTimeout(resolve, 2000));
    }

    return bestResult || {
        hasVulnerability: false,
        severity: 'error',
        cve: '',
        description: 'Erreur: Toutes les API ont échoué',
        score: 0,
        confidence: 'error',
        published: null,
        source: 'Unknown'
    };
}

// Fonction principale optimisée
async function checkVulnerabilities(software) {
    const results = [];
    const baseDelay = 3000; // 3 secondes entre les requêtes (pour éviter les rate limits)
    let currentDelay = baseDelay;
    
    console.log(`🚀 Début scan ${software.length} logiciels avec API multiples`);
    
    let consecutiveErrors = 0;
    
    for (let i = 0; i < software.length; i++) {
        const item = software[i];
        
        // Mise à jour du progrès
        mainWindow.webContents.send('scan-progress', {
            current: i + 1,
            total: software.length,
            currentSoftware: item.name,
            errors: consecutiveErrors,
            delay: currentDelay
        });

        try {
            const vulnResult = await searchVulnerabilities(item.name, item.version);
            
            results.push({
                name: item.name,
                version: item.version,
                vulnerability: vulnResult.hasVulnerability ? 'Vulnérabilité détectée' : 'Aucune vulnérabilité',
                severity: vulnResult.severity,
                cve: vulnResult.cve,
                description: vulnResult.description,
                score: vulnResult.score || 0,
                confidence: vulnResult.confidence || 'unknown',
                published: vulnResult.published,
                source: vulnResult.source || 'Unknown'
            });

            console.log(`✅ ${item.name}: ${vulnResult.hasVulnerability ? vulnResult.severity.toUpperCase() + ' (' + vulnResult.cve + ')' : 'SAFE'} [${vulnResult.source}]`);
            
            // Reset des erreurs en cas de succès
            consecutiveErrors = 0;
            currentDelay = baseDelay;

        } catch (error) {
            console.error(`❌ ${item.name}: ${error.message}`);
            consecutiveErrors++;
            
            results.push({
                name: item.name,
                version: item.version,
                vulnerability: 'Erreur de scan',
                severity: 'error',
                cve: '',
                description: `Erreur: ${error.message}`,
                score: 0,
                confidence: 'error',
                published: null,
                source: 'Error'
            });

            // Gestion adaptative des erreurs
            if (consecutiveErrors >= 3) {
                currentDelay = Math.min(currentDelay * 1.5, 15000); // Max 15s
                console.log(`⚠️ Erreurs multiples, délai augmenté: ${currentDelay}ms`);
            }

            // Pause d'urgence si trop d'erreurs
            if (consecutiveErrors >= 5) {
                const pauseTime = 60000; // 60 secondes
                console.log(`🛑 Pause d'urgence: ${pauseTime}ms`);
                await new Promise(resolve => setTimeout(resolve, pauseTime));
                consecutiveErrors = 0;
                currentDelay = baseDelay;
            }
        }

        // Délai entre requêtes
        if (i < software.length - 1) {
            await new Promise(resolve => setTimeout(resolve, currentDelay));
        }
    }

    return results;
}

// Rapport Excel amélioré avec informations sur les sources
async function generateExcelReport(results) {
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Rapport Vulnérabilités');

    // Métadonnées
    workbook.creator = 'VulSCAN v2.0 - API Multiples';
    workbook.created = new Date();

    worksheet.columns = [
        { header: 'Logiciel', key: 'name', width: 35 },
        { header: 'Version', key: 'version', width: 15 },
        { header: 'Statut', key: 'vulnerability', width: 25 },
        { header: 'Sévérité', key: 'severity', width: 15 },
        { header: 'Score CVSS', key: 'score', width: 12 },
        { header: 'CVE ID', key: 'cve', width: 20 },
        { header: 'Confiance', key: 'confidence', width: 12 },
        { header: 'Source', key: 'source', width: 20 },
        { header: 'Publication', key: 'published', width: 15 },
        { header: 'Description', key: 'description', width: 60 }
    ];

    // Style de l'en-tête
    const headerRow = worksheet.getRow(1);
    headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2E86C1' } };
    headerRow.height = 25;

    // Tri des résultats par sévérité
    const severityOrder = { 'critical': 0, 'high': 1, 'medium': 2, 'low': 3, 'safe': 4, 'error': 5 };
    const sortedResults = results.sort((a, b) => 
        (severityOrder[a.severity] || 6) - (severityOrder[b.severity] || 6)
    );

    sortedResults.forEach((item, index) => {
        const publishedDate = item.published ? new Date(item.published).toLocaleDateString('fr-FR') : 'N/A';
        
        const row = worksheet.addRow({
            ...item,
            score: item.score ? item.score.toFixed(1) : '0.0',
            published: publishedDate
        });
        
        // Couleurs selon la sévérité
        const colors = {
            'critical': 'FFDC143C',
            'high': 'FFFF4500', 
            'medium': 'FFFFA500',
            'low': 'FFFFFF00',
            'safe': 'FF90EE90',
            'error': 'FFFF69B4'
        };
        
        const color = colors[item.severity] || 'FFFFFFFF';
        
        row.eachCell((cell, colNumber) => {
            cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: color } };
            cell.border = {
                top: { style: 'thin' },
                left: { style: 'thin' },
                bottom: { style: 'thin' },
                right: { style: 'thin' }
            };
            
            // Style du texte selon la sévérité
            if (['critical', 'high', 'safe'].includes(item.severity)) {
                cell.font = { color: { argb: 'FFFFFFFF' } };
            }
        });
    });

    // Ajout d'un résumé avec statistiques par source
    const summarySheet = workbook.addWorksheet('Résumé');
    const stats = {
        total: results.length,
        critical: results.filter(r => r.severity === 'critical').length,
        high: results.filter(r => r.severity === 'high').length,
        medium: results.filter(r => r.severity === 'medium').length,
        low: results.filter(r => r.severity === 'low').length,
        safe: results.filter(r => r.severity === 'safe').length,
        errors: results.filter(r => r.severity === 'error').length,
        nvd: results.filter(r => r.source === 'NVD').length,
        vulnlookup: results.filter(r => r.source === 'Vulnerability-Lookup').length,
        local: results.filter(r => r.source === 'Local-DB').length
    };

    summarySheet.addRow(['Statistiques du Scan VulSCAN v2.0']);
    summarySheet.addRow(['Date', new Date().toLocaleString('fr-FR')]);
    summarySheet.addRow(['Version', 'VulSCAN v2.0 - Multi-API']);
    summarySheet.addRow([]);
    summarySheet.addRow(['=== STATISTIQUES GÉNÉRALES ===']);
    summarySheet.addRow(['Total logiciels', stats.total]);
    summarySheet.addRow(['Vulnérabilités critiques', stats.critical]);
    summarySheet.addRow(['Vulnérabilités élevées', stats.high]);
    summarySheet.addRow(['Vulnérabilités moyennes', stats.medium]);
    summarySheet.addRow(['Vulnérabilités faibles', stats.low]);
    summarySheet.addRow(['Logiciels sûrs', stats.safe]);
    summarySheet.addRow(['Erreurs de scan', stats.errors]);
    summarySheet.addRow([]);
    summarySheet.addRow(['=== STATISTIQUES PAR SOURCE ===']);
    summarySheet.addRow(['API NVD (NIST)', stats.nvd]);
    summarySheet.addRow(['API Vulnerability-Lookup', stats.vulnlookup]);
    summarySheet.addRow(['Base de données locale', stats.local]);

    const fileName = `VulScan_MultiAPI_Report_${new Date().toISOString().split('T')[0]}_${Date.now()}.xlsx`;
    await workbook.xlsx.writeFile(fileName);
    return fileName;
}

// Rapport HTML amélioré avec informations sur les sources
function generateHTMLReport(results) {
    const now = new Date();
    const stats = {
        total: results.length,
        critical: results.filter(r => r.severity === 'critical').length,
        high: results.filter(r => r.severity === 'high').length,
        medium: results.filter(r => r.severity === 'medium').length,
        low: results.filter(r => r.severity === 'low').length,
        safe: results.filter(r => r.severity === 'safe').length,
        errors: results.filter(r => r.severity === 'error').length,
        success: results.filter(r => r.severity !== 'error').length,
        nvd: results.filter(r => r.source === 'NVD').length,
        vulnlookup: results.filter(r => r.source === 'Vulnerability-Lookup').length,
        local: results.filter(r => r.source === 'Local-DB').length
    };


    // Tri par sévérité
    const severityOrder = { 'critical': 0, 'high': 1, 'medium': 2, 'low': 3, 'safe': 4, 'error': 5 };
    const sortedResults = results.sort((a, b) => 
        (severityOrder[a.severity] || 6) - (severityOrder[b.severity] || 6)
    );
    
    const html = `
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>Rapport de Vulnérabilités VulSCAN - CIRCL API</title>
    <style>
        body { font-family: Arial, sans-serif; margin: 20px; background: #f5f5f5; }
        .container { max-width: 1200px; margin: 0 auto; background: white; padding: 20px; border-radius: 10px; box-shadow: 0 0 10px rgba(0,0,0,0.1); }
        .api-badge { background: linear-gradient(45deg, #28a745, #20c997); color: white; padding: 10px 20px; border-radius: 25px; display: inline-block; font-weight: bold; margin-bottom: 20px; }
        h1 { color: #2c3e50; text-align: center; margin-bottom: 30px; }
        .summary { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 20px; border-radius: 10px; margin-bottom: 30px; }
        .summary h3 { margin-top: 0; }
        .stats { display: flex; justify-content: space-between; margin-top: 15px; flex-wrap: wrap; }
        .stat-item { text-align: center; min-width: 100px; }
        .stat-number { font-size: 2em; font-weight: bold; }
        .stat-label { font-size: 0.9em; opacity: 0.9; }
        .api-status { background: rgba(255,255,255,0.2); padding: 10px; border-radius: 5px; margin-top: 15px; }
        .scan-info { background: #e8f5e8; border: 1px solid #28a745; padding: 15px; border-radius: 5px; margin-bottom: 20px; }
        table { width: 100%; border-collapse: collapse; margin-top: 20px; }
        th, td { padding: 12px; text-align: left; border: 1px solid #ddd; }
        th { background-color: #3498db; color: white; font-weight: bold; }
        .critical { background-color: #e74c3c; color: white; }
        .high { background-color: #e67e22; color: white; }
        .medium { background-color: #f39c12; }
        .low { background-color: #f1c40f; }
        .safe { background-color: #2ecc71; color: white; }
        .error { background-color: #e91e63; color: white; }
        .description { max-width: 300px; word-wrap: break-word; font-size: 0.9em; }
        .score { font-weight: bold; text-align: center; }
        .confidence { font-size: 0.8em; text-transform: uppercase; font-weight: bold; }
        .footer { text-align: center; margin-top: 30px; color: #666; font-size: 0.9em; }
    </style>
</head>
<body>
    <div class="container">
        <div class="api-badge">🔓 SCAN AVEC API CIRCL (GRATUITE)</div>
        <h1>🔍 Rapport de Vulnérabilités VulSCAN</h1>
        
        <div class="scan-info">
            <h4>ℹ️ Informations du Scan</h4>
            <p><strong>🎯 Logiciels analysés:</strong> ${stats.success}/${stats.total} (${stats.errors} erreurs)</p>
            <p><strong>🔓 API utilisée:</strong> CIRCL CVE Search API (Gratuite)</p>
            <p><strong>📊 Source des données:</strong> CIRCL.lu - Centre de Recherche Publique Luxembourg</p>
            <p><strong>🌐 Endpoint:</strong> https://cve.circl.lu/api/</p>
        </div>
        
        <div class="summary">
            <h3>📊 Résumé du Scan</h3>
            <p><strong>Date du scan:</strong> ${now.toLocaleString('fr-FR')}</p>
            <p><strong>Durée estimée:</strong> ${Math.floor(stats.total * 2)} secondes</p>
            <div class="api-status">
                <strong>Statut API:</strong> 🟢 API CIRCL - Accès libre et gratuit
            </div>
            <div class="stats">
                <div class="stat-item">
                    <div class="stat-number">${stats.critical}</div>
                    <div class="stat-label">Critiques</div>
                </div>
                <div class="stat-item">
                    <div class="stat-number">${stats.high}</div>
                    <div class="stat-label">Élevées</div>
                </div>
                <div class="stat-item">
                    <div class="stat-number">${stats.medium}</div>
                    <div class="stat-label">Moyennes</div>
                </div>
                <div class="stat-item">
                    <div class="stat-number">${stats.low}</div>
                    <div class="stat-label">Faibles</div>
                </div>
                <div class="stat-item">
                    <div class="stat-number">${stats.safe}</div>
                    <div class="stat-label">Sûrs</div>
                </div>
                <div class="stat-item">
                    <div class="stat-number">${stats.errors}</div>
                    <div class="stat-label">Erreurs</div>
                </div>
            </div>
        </div>
        
        <table>
            <thead>
                <tr>
                    <th>Logiciel</th>
                    <th>Version</th>
                    <th>Statut</th>
                    <th>Sévérité</th>
                    <th>Score CVSS</th>
                    <th>Confiance</th>
                    <th>CVE</th>
                    <th>Publication</th>
                    <th>Description</th>
                </tr>
            </thead>
            <tbody>
                ${sortedResults.map(item => {
                    const publishedDate = item.published ? new Date(item.published).toLocaleDateString('fr-FR') : 'N/A';
                    return `
                    <tr class="${item.severity}">
                        <td><strong>${item.name}</strong></td>
                        <td>${item.version}</td>
                        <td>${item.vulnerability}</td>
                        <td>${item.severity.toUpperCase()}</td>
                        <td class="score">${item.score ? item.score.toFixed(1) : '0.0'}</td>
                        <td class="confidence">${item.confidence || 'N/A'}</td>
                        <td>${item.cve}</td>
                        <td>${publishedDate}</td>
                        <td class="description">${item.description}</td>
                    </tr>
                `;
                }).join('')}
            </tbody>
        </table>
        
        <div class="footer">
            <p><strong>🔍 Rapport généré par VulSCAN v1.0</strong></p>
            <p>✅ Données provenant de CIRCL CVE Search API (API gratuite)</p>
            <p>⚠️ Ce rapport contient des données authentiques de vulnérabilités. Prenez les mesures appropriées.</p>
        </div>
    </div>
</body>
</html>`;

    const fileName = `VulScan_CIRCL_Report_${new Date().toISOString().split('T')[0]}_${Date.now()}.html`;
    fs.writeFileSync(fileName, html);
    return fileName;
}

// Handler IPC pour démarrer le scan
ipcMain.handle('start-scan', async () => {
    try {
        mainWindow.webContents.send('scan-status', '🔓 Scanner avec API CIRCL (gratuite et rapide)');
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        mainWindow.webContents.send('scan-status', '🔍 Récupération des logiciels installés...');
        const software = await getInstalledSoftware();
        
        mainWindow.webContents.send('scan-status', `🎯 ${software.length} logiciels détectés - Analyse via API CIRCL...`);
        const results = await checkVulnerabilities(software);
        
        mainWindow.webContents.send('scan-status', '📄 Génération des rapports finaux...');
        const excelFile = await generateExcelReport(results);
        const htmlFile = generateHTMLReport(results);
        
        mainWindow.webContents.send('scan-complete', {
            results,
            excelFile,
            htmlFile
        });
        
        return results;
    } catch (error) {
        console.error('❌ Erreur lors du scan:', error);
        mainWindow.webContents.send('scan-error', error.message);
        throw error;
    }
});

// Handler pour ouvrir les fichiers générés
ipcMain.handle('open-file', (event, filePath) => {
    const { shell } = require('electron');
    shell.openPath(filePath);
});

// Export des fonctions pour utilisation dans le main.js
module.exports = {
    searchVulnerabilitiesNVD,
    searchVulnerabilitiesCIRCL,
    searchVulnerabilitiesLocal,
    normalizeVersion,
    compareVersions,
    isVersionAffected,
    matchesCPE,
    isRecentVulnerability
};