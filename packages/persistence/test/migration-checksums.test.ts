import { afterEach, describe, expect, it } from "vitest";

import { NodeNarrativeDatabase } from "../src/node.js";

/*
 * Checksums of every migration that has shipped. A library stores the
 * checksum of each migration it applied and refuses to open when the code
 * no longer matches (migrate() throws), so an edit to a shipped migration
 * locks every existing library out. Change behavior with a new migration;
 * when an old one truly has to change, add a legacyRepairs entry for the
 * previous checksum and update this list in the same commit.
 *
 * 2026-10-20: migration 1's default project language was edited (zh-CN to
 * pt-BR) and existing libraries stopped opening; its entry below is the
 * checksum real libraries carry.
 */
const SHIPPED: readonly (readonly [number, string, string])[] = [
  [
    1,
    "foundation",
    "d0b4c30b04dbb7727ae9f8c90619d3ef2b836b522b3bbc14fdba218e6afccd43",
  ],
  [
    2,
    "story-kernel",
    "1061ffad715a71537c4d6b1514908b0549a2fe2f537a96f52c40815cecbd8a58",
  ],
  [
    3,
    "recoverable-harness",
    "ac8d6f5d55ea99cda4d4c9048878f86d894cef74e4b2d3104b8a55e93074182f",
  ],
  [
    4,
    "autonomous-production",
    "375bfc020a73ab53a635ee1ea9aafafdb9d518362a78ec17b242cb7c694d7089",
  ],
  [
    5,
    "cocreate-studio",
    "1b26f62fdab4ad5e79f4270cb52bf0faba6863655c241101540fda40cb01e1b1",
  ],
  [
    6,
    "delivery-and-portability",
    "c8ec9f9a2737e0e9804114c42f10027e1a8db2c5b5a81957eb54b5effca6d068",
  ],
  [
    7,
    "editing-safety-and-drafts",
    "66cd578c55a91287cdd8df6d96886bbd81cfbef8f39222b32d172c7ee1e96dcb",
  ],
  [
    8,
    "canon-fact-withdrawals",
    "450e8ed93796b65e48e79d0c59feb4aa6fa423a1069092e1ce6d0cfa6e7a6f60",
  ],
  [
    9,
    "review-workspace",
    "bc9fedb8d4a40d0fb7e46fad61dd31330543503b58311fb05876a8599bac2e8b",
  ],
  [
    10,
    "persistent-run-streams",
    "8b69b38c235a650732d90684094a294808f8b8878a2f131cae185a3cb5c627cc",
  ],
  [
    11,
    "long-novel-intelligence",
    "24f921483fb7f8f14f7a45e4862da8b8ec83d8568f576d1266d346fac26de5ce",
  ],
  [
    12,
    "product-lifecycle-and-chunked-imports",
    "715cfd3252f54acaca75f42e64851ef701004ad667e11a6eb2194840ff5e6dd0",
  ],
  [
    13,
    "resilient-import-analysis",
    "33d073a8e22e8e4cf285d2186ea4498f66cc3a3e624f6136839e6a50b0e28e50",
  ],
  [
    14,
    "data-safety",
    "f882c7e277d5d9c61c058bd028d9f6a87a11ca110f39a8aa83d4b8cc95f6ad20",
  ],
  [
    15,
    "llm-call-interruption",
    "eee159005cab04f67d499b4c8aa319d0c55f62e6d981baebf1562861dc2b7859",
  ],
  [
    16,
    "providers-models-assignments",
    "d56b3a6381a34f9643e50ed42b2901fe8315c2a275da4877e91a792413b7e99a",
  ],
  [
    17,
    "profile-fk-to-models",
    "2b80c62d0ab9b8d7c5f9b2fffc4f9867d7b0e69c5befd5da93fd484b2d61119e",
  ],
  [
    18,
    "018-run-observability",
    "30581eb97c1d7a470b62001b80e95a6c080244e9747db0288f6e1c08379176ab",
  ],
  [
    19,
    "019-physical-call-reservations",
    "743d995b5a357e2ea5705b4c9be99535000b63408a246c6213c67aade7802cf5",
  ],
  [
    20,
    "020-model-runtime-convergence",
    "6aa824aa4a32065181e3a5dd976f70b070fe5c63832e15abc1ca11d7bdbc2777",
  ],
  [
    21,
    "021-cross-chapter-settlement",
    "fe4e553ff9b8678fbba6babe419dcee83de7ed1296cd745829e911999730526a",
  ],
  [
    22,
    "022-project-foundation-requests",
    "304d0e0701bec7878b0acd9428295784ca9253e2729aed826f7ffd439e4c8f3d",
  ],
  [
    23,
    "chapter-document-identity",
    "b1f666c4425d817f593b39ca166e595fde19b8f67c11d066bfaf2d5e9fd2da66",
  ],
  [
    24,
    "normalize-current-document-segments",
    "02c51adbbb74b8b3d650772ef3b191923aad205911521382ef2eab0f0fc00848",
  ],
  [
    25,
    "project-assistant",
    "c61b641f0a87a75f34c7b70424dc165a15536d9f8a664980277ee085485f8006",
  ],
  [
    26,
    "canon-candidate-decisions",
    "e3df7c21d0fb8f2f6b5d7686fcdbadad5f5e26ac6753f0aaeccc326354c4890a",
  ],
  [
    27,
    "project-covers",
    "3fe415d6e064dd3d628203977a076a25e4c35b54f7e58ec2c07bb2851f8517b2",
  ],
  [
    28,
    "timeline-updated-at",
    "a69974472292c9d7440013c2f0976abd00ee60ee7d37feab668595fa6256e1ec",
  ],
  [
    29,
    "request-replays",
    "4657783433a88dddcbbce1fd7e92eaa31d7a314a5512d9f77e54909f54ec0672",
  ],
  [
    30,
    "import-upload-batch-link",
    "4edf94dcdead7f370ceb2ae51f683fd90f49d2df567f06613d81aa9a4abacc60",
  ],
  [
    31,
    "collaboration-versions",
    "a3c0285101c4a64510b14cbbbb46e1fa398f54e8fb66ba4e5e59afe12d940509",
  ],
  [
    32,
    "assistant-activity-identity",
    "7efa1e73c8f4c3bcb6bba2bdaab337b50514cabb2544d89dfb96d337c84f0866",
  ],
  [
    33,
    "assistant-long-goals",
    "09e0cfd0eb1a3725a2fe6c04ae2be623bb76e554802d64803244998ce0e3a8ce",
  ],
  [
    34,
    "project-backup-counts",
    "ab9c2382103d3fb1ee8997d3670f269b3c41e53dce75dbbbfc5c1a79e60ea3ce",
  ],
  [
    35,
    "imported-agent-skills",
    "830e78a5e857e47a8d7e801ad6363e08b30ab59232f379a189a20389306bd94e",
  ],
  [
    36,
    "drop-empty-manuscript-documents",
    "098dec9ee65be16834327d83ce150803c105f18709dad768ec17f0c105dc839b",
  ],
  [
    37,
    "assistant-conversation-settings",
    "7bba415a604a4be9f4292b427bef275ba86a44c1c95346daf9ce53f29f344ab9",
  ],
  [
    38,
    "drop-run-budget-limits",
    "70908c3742a863fff7744df8647f94f7b63ed9415071f5871326d316c4c8d157",
  ],
  [
    39,
    "resource-lifecycle",
    "50aa4a62de49d2c09ceca55783cb2c28549f20ef42532a7eaa9d9bd42954b113",
  ],
  [
    40,
    "project-write-guard",
    "189375316f3367e55ade6a70c63d307b7b094428840791c54cb48c1f6c86a735",
  ],
  [
    41,
    "review-author-decisions",
    "1834837b8e22d39522b59f34d6a8b4842409a201bd6ba63463096c839b0c5ab0",
  ],
  [
    42,
    "cocreate-natural-speaker",
    "fd64600568dee9b89b86f7b7e927c52f97df86f7da3aa0479e5fdc8deac69355",
  ],
  [
    43,
    "persona-card-profile",
    "5050fa57194477a4fc4745a8055a5e488a57dd4d42c619b960b08cf56e051021",
  ],
  [
    44,
    "lorebooks",
    "2a412c00dad84124fbeaf70fe75c81e544537fd4c383e60193768c10b7a4d833",
  ],
  [
    45,
    "knowledge-corrections",
    "71dd2682f153b13fe5584cc1f10da841f0007a5cf2b188c3d41f9eb8e0c43554",
  ],
  [
    46,
    "bible-backfill",
    "1975a0c412dfe76c1a70dc00fbc31d208ad365c668e307bbd33669e71215ed33",
  ],
  [
    47,
    "foreshadow-source",
    "3528994dc42261644859ce8ee497674e63b9206b2b253aef98e92e860f92fc99",
  ],
  [
    48,
    "language-and-form",
    "efec5f61b8454e6f4df262ec07de362ade2d468ed025a9b5c94029f2a03cf979",
  ],
  [
    49,
    "retrieval-word-index",
    "5a4d43e472fc8318942a4d7422cbcd514e21d11f16b746e75dfdcc2a3faea023",
  ],
  [
    50,
    "binary-segment-vectors",
    "d7e295c2d3e4766314954f02ffa904b1ae50b5091a48847acaaa49390a0a6ebb",
  ],
];

const databases: NodeNarrativeDatabase[] = [];
afterEach(() => {
  while (databases.length) databases.pop()?.close();
});

describe("shipped migration checksums", () => {
  it("never change once a migration has shipped", () => {
    const database = new NodeNarrativeDatabase();
    databases.push(database);
    database.migrate();
    const applied = database.raw
      .prepare(
        "SELECT version, name, checksum FROM schema_migrations ORDER BY version",
      )
      .all() as unknown as {
      version: number;
      name: string;
      checksum: string;
    }[];
    for (const [version, name, checksum] of SHIPPED) {
      expect(
        applied.find((row) => row.version === version),
        `migration ${version} (${name}) changed after shipping`,
      ).toEqual({ version, name, checksum });
    }
  });
});
