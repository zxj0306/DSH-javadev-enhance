/**
 * Pre-set intents: minimal one-word descriptions that expand into a full
 * deterministic set of template operations.
 *
 * Usage (java_apply):
 *   {"path":"...", "intent":"pojo", "name":"User", "fields":[["Long","id"],["String","name"]]}
 * or inside ops:
 *   {"ops":{"intent":{"name":"service","name":"UserService","dependencies":[["UserRepository","repo"]]}}}
 *
 * Every preset returns { ops, imports } where ops is the same op object the
 * template engine already understands.
 */

function requiredName(params) {
  const name = params && params.name;
  if (!name) throw new Error(`intent requires "name"`);
  return name;
}

/** Normalize [type,name] / {type,name} / "Type name" field specs. */
function fieldSpecs(params, defaultModifiers = ['private']) {
  return (params.fields || []).map((f) => {
    if (Array.isArray(f)) return { type: String(f[0]), name: String(f[1]), modifiers: defaultModifiers };
    if (typeof f === 'string') {
      const idx = f.trim().lastIndexOf(' ');
      if (idx < 0) throw new Error(`invalid field spec: ${f}`);
      return { type: f.slice(0, idx).trim(), name: f.slice(idx + 1).trim(), modifiers: defaultModifiers };
    }
    return {
      modifiers: f.modifiers || defaultModifiers,
      type: f.type,
      name: f.name,
      ...(f.value !== undefined ? { value: f.value } : {}),
      ...(f.annotations ? { annotations: f.annotations } : {})
    };
  });
}

function depSpecs(params) {
  return (params.dependencies || []).map((d) => (Array.isArray(d) ? { type: d[0], name: d[1] } : d));
}

function lowerFirst(text) {
  return text ? text[0].toLowerCase() + text.slice(1) : text;
}

function plural(text) {
  return lowerFirst(text) + 's';
}

const PRESETS = {
  /** Plain data class with accessors, equals/hashCode, toString. */
  pojo(params = {}) {
    const name = requiredName(params);
    const ops = {
      class: {
        name,
        modifiers: params.modifiers || ['public'],
        typeParams: params.typeParams,
        extends: params.extends,
        implements: params.implements,
        annotations: params.annotations,
        fields: fieldSpecs(params)
      },
      getters: {},
      setters: {},
      equalsHashCode: {},
      toString: {}
    };
    if (params.builder) ops.builder = {};
    if (params.logger) ops.logger = {};
    if (params.constructors) ops.constructors = params.constructors;
    return { ops, imports: [] };
  },

  /** Immutable value class: final class, final fields, all-args ctor, getters. */
  immutable(params = {}) {
    const name = requiredName(params);
    return {
      ops: {
        class: {
          name,
          modifiers: params.modifiers || ['public', 'final'],
          typeParams: params.typeParams,
          implements: params.implements,
          annotations: params.annotations,
          fields: fieldSpecs(params, ['private', 'final'])
        },
        constructors: [{ modifiers: ['public'] }],
        getters: {},
        equalsHashCode: {},
        toString: {}
      },
      imports: []
    };
  },

  /** Record with optional builder. */
  record(params = {}) {
    const name = requiredName(params);
    const ops = {
      record: {
        name,
        modifiers: params.modifiers || ['public'],
        typeParams: params.typeParams,
        implements: params.implements,
        annotations: params.annotations,
        fields: fieldSpecs(params, [])
      }
    };
    if (params.builder) ops.builder = {};
    if (params.compactConstructor) ops.compactConstructor = params.compactConstructor === true ? {} : params.compactConstructor;
    return { ops, imports: [] };
  },

  /** Record plus fluent builder (handy DTO for token-cheap definitions). */
  recordBuilder(params = {}) {
    return PRESETS.record({ ...params, builder: true });
  },

  /** Serializable DTO: no-arg + all-args ctor, accessors, toString. */
  dto(params = {}) {
    const name = requiredName(params);
    return {
      ops: {
        class: {
          name,
          modifiers: params.modifiers || ['public'],
          implements: [...new Set([...(params.implements || []), 'Serializable'])],
          annotations: params.annotations,
          fields: fieldSpecs(params)
        },
        constructors: [{ modifiers: ['public'], params: [], body: '' }, { modifiers: ['public'] }],
        getters: {},
        setters: {},
        toString: {},
        equalsHashCode: {}
      },
      imports: ['java.io.Serializable']
    };
  },

  /** JPA entity skeleton. */
  entity(params = {}) {
    const name = requiredName(params);
    const table = params.table || plural(name);
    const idType = params.idType || 'Long';
    const fields = [
      {
        modifiers: ['private'],
        type: idType,
        name: 'id',
        annotations: ['Id', 'GeneratedValue(strategy = GenerationType.IDENTITY)']
      },
      ...fieldSpecs(params)
    ];
    return {
      ops: {
        class: {
          name,
          modifiers: ['public'],
          annotations: [
            'Entity',
            `Table(name = "${table}")`,
            ...(params.annotations || [])
          ],
          implements: ['Serializable'],
          fields
        },
        constructors: [{ modifiers: ['public'], params: [], body: '' }],
        getters: {},
        setters: {},
        equalsHashCode: { fields: ['id'] },
        toString: {}
      },
      imports: [
        'jakarta.persistence.Entity',
        'jakarta.persistence.Table',
        'jakarta.persistence.Id',
        'jakarta.persistence.GeneratedValue',
        'jakarta.persistence.GenerationType',
        'java.io.Serializable'
      ]
    };
  },

  /** Spring service with constructor injection and SLF4J logger. */
  service(params = {}) {
    const name = requiredName(params);
    const deps = depSpecs(params);
    const ops = {
      class: {
        name,
        modifiers: ['public'],
        annotations: ['Service', ...(params.annotations || [])],
        fields: deps.map((d) => ({ modifiers: ['private', 'final'], type: d.type, name: d.name }))
      },
      logger: { framework: 'slf4j' }
    };
    if (deps.length) ops.constructors = [{ modifiers: ['public'], params: deps.map((d) => ({ type: d.type, name: d.name })) }];
    if (params.methods) ops.methods = params.methods;
    return {
      ops,
      imports: ['org.springframework.stereotype.Service', 'org.slf4j.Logger', 'org.slf4j.LoggerFactory']
    };
  },

  /** Spring REST controller with one default route. */
  controller(params = {}) {
    const name = requiredName(params);
    const basePath = params.basePath || '/api/' + lowerFirst(name.replace(/Controller$/, ''));
    const routes = params.routes || [
      {
        method: 'GET',
        path: '/{id}',
        name: 'get',
        returnType: 'Object',
        params: [{ type: 'Long', name: 'id' }],
        body: 'return null;'
      }
    ];
    const methods = routes.map((r) => {
      const verb = (r.method || 'GET').toUpperCase();
      const mapping = `${verb === 'GET' ? 'Get' : verb === 'POST' ? 'Post' : verb === 'PUT' ? 'Put' : verb === 'DELETE' ? 'Delete' : 'Request'}Mapping("${r.path || ''}")`;
      return {
        name: r.name || lowerFirst(verb),
        annotations: [mapping],
        returnType: r.returnType || 'Object',
        params: r.params || [],
        body: r.body || 'return null;'
      };
    });
    const verbs = [...new Set(routes.map((r) => (r.method || 'GET').toUpperCase()))]
      .map((v) => `${v === 'GET' ? 'Get' : v === 'POST' ? 'Post' : v === 'PUT' ? 'Put' : v === 'DELETE' ? 'Delete' : 'Request'}Mapping`);
    return {
      ops: {
        class: {
          name,
          modifiers: ['public'],
          annotations: [`RestController`, `RequestMapping("${basePath}")`, ...(params.annotations || [])]
        },
        methods
      },
      imports: [
        'org.springframework.web.bind.annotation.RestController',
        'org.springframework.web.bind.annotation.RequestMapping',
        ...verbs.map((m) => `org.springframework.web.bind.annotation.${m}`)
      ]
    };
  },

  /** Spring Data repository interface. */
  repository(params = {}) {
    const name = requiredName(params);
    const entity = params.entity || 'Entity';
    const idType = params.idType || 'Long';
    return {
      ops: {
        interface: {
          name,
          modifiers: ['public'],
          annotations: ['Repository'],
          extends: [`JpaRepository<${entity}, ${idType}>`],
          methods: params.methods || []
        }
      },
      imports: [
        'org.springframework.data.jpa.repository.JpaRepository',
        'org.springframework.stereotype.Repository',
        params.entityPackage ? `${params.entityPackage}.${entity.replace(/<.*/, '')}` : null
      ].filter(Boolean)
    };
  },

  /** JUnit 5 test class. */
  test(params = {}) {
    const target = params.target;
    const name = requiredName(params) || (target ? target + 'Test' : 'SampleTest');
    const tests = params.methods || [
      { name: 'shouldWork', body: 'Assertions.assertTrue(true);' }
    ];
    return {
      ops: {
        class: {
          name,
          modifiers: ['public'],
          annotations: params.annotations,
          fields: target ? [{ modifiers: ['private'], type: target, name: 'subject' }] : []
        },
        methods: tests.map((t) => ({
          name: t.name,
          annotations: ['Test'],
          returnType: 'void',
          params: t.params || [],
          body: t.body || 'Assertions.assertTrue(true);'
        }))
      },
      imports: ['org.junit.jupiter.api.Test', 'org.junit.jupiter.api.Assertions']
    };
  },

  /** Eager singleton. */
  singleton(params = {}) {
    const name = requiredName(params);
    return {
      ops: {
        class: {
          name,
          modifiers: ['public'],
          annotations: params.annotations,
          fields: fieldSpecs(params)
        },
        singleton: {},
        getters: {}
      },
      imports: []
    };
  },

  /** Custom unchecked exception with standard constructors. */
  exception(params = {}) {
    const name = requiredName(params);
    return {
      ops: {
        class: {
          name,
          modifiers: ['public'],
          extends: params.extends || 'RuntimeException',
          fields: fieldSpecs(params)
        },
        constructors: [
          { modifiers: ['public'], params: [], body: '' },
          { modifiers: ['public'], params: [{ type: 'String', name: 'message' }], body: 'super(message);' },
          {
            modifiers: ['public'],
            params: [{ type: 'String', name: 'message' }, { type: 'Throwable', name: 'cause' }],
            body: 'super(message, cause);'
          }
        ]
      },
      imports: []
    };
  },

  /** Class with a main method. */
  main(params = {}) {
    const name = requiredName(params);
    return {
      ops: {
        class: { name, modifiers: ['public'] },
        main: { body: params.body || 'System.out.println("Hello, world!");' }
      },
      imports: []
    };
  },

  /** Enum with constants and optional members. */
  enum(params = {}) {
    const name = requiredName(params);
    return {
      ops: {
        enum: {
          name,
          modifiers: params.modifiers || ['public'],
          annotations: params.annotations,
          constants: params.constants || ['A', 'B', 'C'],
          fields: fieldSpecs(params),
          methods: params.methods
        }
      },
      imports: []
    };
  },

  /** Interface with method declarations. */
  interface(params = {}) {
    const name = requiredName(params);
    return {
      ops: {
        interface: {
          name,
          modifiers: params.modifiers || ['public'],
          annotations: params.annotations,
          typeParams: params.typeParams,
          extends: params.extends,
          methods: params.methods || [{ returnType: 'void', name: 'run' }]
        }
      },
      imports: []
    };
  },

  /** Annotation type with elements. */
  annotation(params = {}) {
    const name = requiredName(params);
    return {
      ops: {
        annotation: {
          name,
          modifiers: params.modifiers || ['public'],
          annotations: params.annotations,
          members: params.members || [{ type: 'String', name: 'value' }]
        }
      },
      imports: []
    };
  },

  /** Sealed class/interface with permitted subtypes (nested, so the file compiles). */
  sealed(params = {}) {
    const name = requiredName(params);
    const kind = params.kind === 'interface' ? 'interface' : 'class';
    const permits = (params.permits || []).map(String);
    const spec = {
      name,
      modifiers: ['public', 'sealed'],
      annotations: params.annotations
    };
    if (kind === 'class') spec.fields = fieldSpecs(params);
    if (permits.length) {
      spec.permits = permits.map((p) => (p.includes('.') ? p : `${name}.${p}`));
      spec.body = permits
        .map((p) => {
          const simple = p.split('.').pop();
          return kind === 'interface'
            ? `public static final class ${simple} implements ${name} {\n}`
            : `public static final class ${simple} extends ${name} {\n}`;
        })
        .join('\n\n');
    }
    const ops = { [kind]: spec };
    if (params.methods) ops.methods = params.methods;
    return { ops, imports: [] };
  },

  /** Spring @Configuration with one @Bean method. */
  config(params = {}) {
    const name = requiredName(params);
    return {
      ops: {
        class: { name, modifiers: ['public'], annotations: ['Configuration', ...(params.annotations || [])] },
        methods: [
          {
            name: params.beanName || lowerFirst((params.beanType || 'Object').split('<')[0]),
            annotations: ['Bean'],
            returnType: params.beanType || 'Object',
            body: params.body || 'return null;'
          }
        ]
      },
      imports: ['org.springframework.context.annotation.Configuration', 'org.springframework.context.annotation.Bean']
    };
  },

  /** Android Activity skeleton. */
  activity(params = {}) {
    const name = requiredName(params);
    return {
      ops: {
        class: {
          name,
          modifiers: ['public'],
          extends: params.extends || 'AppCompatActivity',
          annotations: params.annotations,
          fields: fieldSpecs(params)
        },
        methods: [
          {
            name: 'onCreate',
            annotations: ['Override'],
            modifiers: ['protected'],
            returnType: 'void',
            params: [{ type: 'Bundle', name: 'savedInstanceState' }],
            body: `super.onCreate(savedInstanceState);\nsetContentView(R.layout.${params.layout || 'activity_main'});`
          }
        ],
        getters: {}
      },
      imports: [
        'android.os.Bundle',
        params.extends ? null : 'androidx.appcompat.app.AppCompatActivity'
      ].filter(Boolean)
    };
  },

  /** Final utility class: private constructor, static methods. */
  util(params = {}) {
    const name = requiredName(params);
    return {
      ops: {
        class: { name, modifiers: ['public', 'final'] },
        constructors: [{ modifiers: ['private'], params: [], body: '' }],
        methods: params.methods || [{ modifiers: ['public', 'static'], returnType: 'void', name: 'run' }]
      },
      imports: []
    };
  },

  /** Constants holder. */
  constant(params = {}) {
    const name = requiredName(params);
    const fields = (params.constants || []).map((c) =>
      Array.isArray(c)
        ? { modifiers: ['public', 'static', 'final'], type: c[0] || 'String', name: c[1], value: c[2] }
        : { modifiers: ['public', 'static', 'final'], type: c.type || 'String', name: c.name, value: c.value }
    );
    return {
      ops: {
        class: { name, modifiers: ['public', 'final'], fields },
        constructors: [{ modifiers: ['private'], params: [], body: '' }]
      },
      imports: []
    };
  },

  // -------------------------------------------------------------------------
  // high-performance / rendering intents
  // -------------------------------------------------------------------------

  /** nanoTime benchmark harness with warmup + blackhole (JDK only). */
  benchmark(params = {}) {
    const name = requiredName(params);
    const workBody = params.body || [
      'long acc = seed;',
      'for (int i = 0; i < 64; i++) {',
      '    acc = acc * 31 + i;',
      '}',
      'return acc;'
    ].join('\n');
    return {
      ops: {
        class: { name, modifiers: ['public', 'final'] },
        fields: [
          { modifiers: ['private', 'static', 'final'], type: 'int', name: 'WARMUP', value: '5_000' },
          { modifiers: ['private', 'static', 'final'], type: 'int', name: 'ITERATIONS', value: '20_000' }
        ],
        methods: [
          {
            modifiers: ['public'],
            returnType: 'void',
            name: 'main',
            params: [{ type: 'String[]', name: 'args' }],
            body: [
              'for (int i = 0; i < WARMUP; i++) blackhole(work(i));',
              'long start = System.nanoTime();',
              'long checksum = 0;',
              'for (int i = 0; i < ITERATIONS; i++) checksum += work(i);',
              'long elapsed = System.nanoTime() - start;',
              'System.out.printf("checksum=%d ns/op=%.2f%n", checksum, (double) elapsed / ITERATIONS);'
            ].join('\n')
          },
          {
            modifiers: ['private', 'static'],
            returnType: 'long',
            name: 'work',
            params: [{ type: 'long', name: 'seed' }],
            body: workBody
          },
          {
            modifiers: ['private', 'static'],
            returnType: 'void',
            name: 'blackhole',
            params: [{ type: 'long', name: 'value' }],
            body: 'if (value == Long.MIN_VALUE) System.out.print("");'
          }
        ]
      },
      imports: []
    };
  },

  /** Single-producer/single-consumer lock-free ring buffer. */
  ringbuf(params = {}) {
    const name = requiredName(params);
    return {
      ops: {
        class: { name, modifiers: ['public', 'final'], typeParams: params.typeParams || ['T'] },
        fields: [
          { modifiers: ['private', 'final'], type: 'Object[]', name: 'buffer' },
          { modifiers: ['private', 'final'], type: 'int', name: 'mask' },
          { modifiers: ['private', 'final'], type: 'AtomicLong', name: 'head', value: 'new AtomicLong()' },
          { modifiers: ['private', 'final'], type: 'AtomicLong', name: 'tail', value: 'new AtomicLong()' }
        ],
        constructors: [{
          modifiers: ['public'],
          params: [{ type: 'int', name: 'requestedCapacity' }],
          body: [
            'int capacity = Integer.highestOneBit(Math.max(2, requestedCapacity - 1)) << 1;',
            'this.buffer = new Object[capacity];',
            'this.mask = capacity - 1;'
          ].join('\n')
        }],
        methods: [
          {
            modifiers: ['public'],
            returnType: 'boolean',
            name: 'offer',
            params: [{ type: 'T', name: 'value' }],
            body: [
              'long tailIndex = tail.get();',
              'if (tailIndex - head.get() >= buffer.length) {',
              '    return false;',
              '}',
              'buffer[(int) (tailIndex & mask)] = value;',
              'tail.lazySet(tailIndex + 1);',
              'return true;'
            ].join('\n')
          },
          {
            modifiers: ['public'],
            returnType: 'T',
            name: 'poll',
            annotations: [{ name: 'SuppressWarnings', value: 'unchecked' }],
            params: [],
            body: [
              'long headIndex = head.get();',
              'if (headIndex >= tail.get()) {',
              '    return null;',
              '}',
              'int index = (int) (headIndex & mask);',
              'T value = (T) buffer[index];',
              'buffer[index] = null;',
              'head.lazySet(headIndex + 1);',
              'return value;'
            ].join('\n')
          },
          {
            modifiers: ['public'],
            returnType: 'int',
            name: 'size',
            params: [],
            body: 'return (int) (tail.get() - head.get());'
          }
        ]
      },
      imports: ['java.util.concurrent.atomic.AtomicLong']
    };
  },

  /** Simple object pool backed by an ArrayDeque. */
  objectpool(params = {}) {
    const name = requiredName(params);
    return {
      ops: {
        class: { name, modifiers: ['public', 'final'], typeParams: params.typeParams || ['T'] },
        fields: [
          { modifiers: ['private', 'final'], type: 'Supplier<T>', name: 'factory' },
          { modifiers: ['private', 'final'], type: 'Deque<T>', name: 'available', value: 'new ArrayDeque<>()' }
        ],
        constructors: [{
          modifiers: ['public'],
          params: [{ type: 'Supplier<T>', name: 'factory' }],
          body: 'this.factory = factory;'
        }],
        methods: [
          {
            modifiers: ['public'],
            returnType: 'T',
            name: 'acquire',
            params: [],
            body: 'return available.isEmpty() ? factory.get() : available.pop();'
          },
          {
            modifiers: ['public'],
            returnType: 'void',
            name: 'release',
            params: [{ type: 'T', name: 'value' }],
            body: 'available.push(value);'
          },
          {
            modifiers: ['public'],
            returnType: 'int',
            name: 'pooled',
            params: [],
            body: 'return available.size();'
          }
        ]
      },
      imports: ['java.util.ArrayDeque', 'java.util.Deque', 'java.util.function.Supplier']
    };
  },

  /** Struct-of-arrays container with growth and raw array access. */
  soa(params = {}) {
    const name = requiredName(params);
    const fields = fieldSpecs(params, ['private']);
    const specs = fields.length ? fields : [{ type: 'float', name: 'value', modifiers: ['private'] }];
    const fieldsOps = [
      { modifiers: ['private'], type: 'int', name: 'size' },
      ...specs.map((f) => ({ modifiers: ['private'], type: `${f.type}[]`, name: f.name }))
    ];
    const ctorBody = specs.map((f) => `this.${f.name} = new ${f.type}[capacity];`).join('\n');
    const ensureBlock = specs.map((f) => [
      `if (min <= ${f.name}.length) return;`,
      `int ${f.name}Next = Math.max(min, ${f.name}.length << 1);`,
      `${f.type}[] ${f.name}Grown = new ${f.type}[${f.name}Next];`,
      `System.arraycopy(${f.name}, 0, ${f.name}Grown, 0, size);`,
      `${f.name} = ${f.name}Grown;`
    ].join('\n')).join('\n');
    const addBody = [
      'ensureCapacity(size + 1);',
      'int index = size++;',
      ...specs.map((f) => `this.${f.name}[index] = ${f.name};`),
      'return index;'
    ].join('\n');
    const accessors = specs.map((f) => ({
      modifiers: ['public'],
      returnType: `${f.type}[]`,
      name: f.name,
      params: [],
      body: `return ${f.name};`
    }));
    return {
      ops: {
        class: { name, modifiers: ['public', 'final'] },
        fields: fieldsOps,
        constructors: [{
          modifiers: ['public'],
          params: [{ type: 'int', name: 'capacity' }],
          body: ctorBody
        }],
        methods: [
          {
            modifiers: ['private'],
            returnType: 'void',
            name: 'ensureCapacity',
            params: [{ type: 'int', name: 'min' }],
            body: ensureBlock
          },
          {
            modifiers: ['public'],
            returnType: 'int',
            name: 'add',
            params: specs.map((f) => ({ type: f.type, name: f.name })),
            body: addBody
          },
          {
            modifiers: ['public'],
            returnType: 'int',
            name: 'size',
            params: [],
            body: 'return size;'
          },
          ...accessors
        ]
      },
      imports: []
    };
  },

  /** 4x4 float matrix math with direct array access. */
  mat4(params = {}) {
    const name = requiredName(params);
    return {
      ops: {
        class: { name, modifiers: ['public', 'final'] },
        fields: [{ modifiers: ['public', 'final'], type: 'float[]', name: 'm', value: 'new float[16]' }],
        constructors: [{
          modifiers: ['public'], params: [], body: 'identity();'
        }],
        methods: [
          {
            modifiers: ['public'], returnType: 'void', name: 'identity', params: [],
            body: 'java.util.Arrays.fill(m, 0f);\nm[0] = m[5] = m[10] = m[15] = 1f;'
          },
          {
            modifiers: ['public'], returnType: 'void', name: 'copy', params: [{ type: 'float[]', name: 'source' }],
            body: 'System.arraycopy(source, 0, m, 0, 16);'
          },
          {
            modifiers: ['public'], returnType: 'void', name: 'multiply',
            params: [{ type: name, name: 'a' }, { type: name, name: 'b' }],
            body: [
              'for (int col = 0; col < 4; col++) {',
              '    for (int row = 0; row < 4; row++) {',
              '        float sum = 0f;',
              '        for (int k = 0; k < 4; k++) {',
              '            sum += a.m[k * 4 + row] * b.m[col * 4 + k];',
              '        }',
              '        m[col * 4 + row] = sum;',
              '    }',
              '}'
            ].join('\n')
          },
          {
            modifiers: ['public'], returnType: 'void', name: 'transform',
            params: [
              { type: 'float', name: 'x' }, { type: 'float', name: 'y' }, { type: 'float', name: 'z' },
              { type: 'float[]', name: 'out' }
            ],
            body: [
              'float tx = m[0] * x + m[4] * y + m[8] * z + m[12];',
              'float ty = m[1] * x + m[5] * y + m[9] * z + m[13];',
              'float tz = m[2] * x + m[6] * y + m[10] * z + m[14];',
              'float tw = m[3] * x + m[7] * y + m[11] * z + m[15];',
              'out[0] = tx;',
              'out[1] = ty;',
              'out[2] = tz;',
              'out[3] = tw;'
            ].join('\n')
          }
        ]
      },
      imports: []
    };
  },

  /** Fixed-timestep game/simulation loop with interpolation alpha. */
  gameloop(params = {}) {
    const name = requiredName(params);
    const hz = params.hz || 60;
    return {
      ops: {
        class: { name, modifiers: ['public'] },
        fields: [
          { modifiers: ['private', 'static', 'final'], type: 'double', name: 'FIXED_DT', value: `1.0 / ${hz}.0` },
          { modifiers: ['private', 'static', 'final'], type: 'double', name: 'MAX_FRAME_TIME', value: '0.25' },
          { modifiers: ['private'], type: 'boolean', name: 'running', value: 'true' },
          { modifiers: ['private'], type: 'double', name: 'accumulator' }
        ],
        methods: [
          {
            modifiers: ['public'], returnType: 'void', name: 'stop', params: [],
            body: 'running = false;'
          },
          {
            modifiers: ['public'], returnType: 'void', name: 'run', params: [],
            body: [
              'long previous = System.nanoTime();',
              'while (running) {',
              '    long now = System.nanoTime();',
              '    double frameTime = Math.min((now - previous) / 1_000_000_000.0, MAX_FRAME_TIME);',
              '    previous = now;',
              '    accumulator += frameTime;',
              '    while (accumulator >= FIXED_DT) {',
              '        update(FIXED_DT);',
              '        accumulator -= FIXED_DT;',
              '    }',
              '    render(accumulator / FIXED_DT);',
              '}'
            ].join('\n')
          },
          {
            modifiers: ['protected'], returnType: 'void', name: 'update',
            params: [{ type: 'double', name: 'dt' }], body: ''
          },
          {
            modifiers: ['protected'], returnType: 'void', name: 'render',
            params: [{ type: 'double', name: 'alpha' }], body: ''
          }
        ]
      },
      imports: []
    };
  },

  /** Software RGBA framebuffer (int[] pixels). */
  framebuffer(params = {}) {
    const name = requiredName(params);
    return {
      ops: {
        class: { name, modifiers: ['public', 'final'] },
        fields: [
          { modifiers: ['public', 'final'], type: 'int', name: 'width' },
          { modifiers: ['public', 'final'], type: 'int', name: 'height' },
          { modifiers: ['public', 'final'], type: 'int[]', name: 'pixels' }
        ],
        constructors: [{
          modifiers: ['public'],
          params: [{ type: 'int', name: 'width' }, { type: 'int', name: 'height' }],
          body: [
            'if (width <= 0 || height <= 0) {',
            '    throw new IllegalArgumentException("invalid framebuffer size");',
            '}',
            'this.width = width;',
            'this.height = height;',
            'this.pixels = new int[width * height];'
          ].join('\n')
        }],
        methods: [
          {
            modifiers: ['public'], returnType: 'void', name: 'clear',
            params: [{ type: 'int', name: 'argb' }],
            body: 'java.util.Arrays.fill(pixels, argb);'
          },
          {
            modifiers: ['public'], returnType: 'void', name: 'set',
            params: [{ type: 'int', name: 'x' }, { type: 'int', name: 'y' }, { type: 'int', name: 'argb' }],
            body: [
              'if (x < 0 || y < 0 || x >= width || y >= height) {',
              '    return;',
              '}',
              'pixels[y * width + x] = argb;'
            ].join('\n')
          },
          {
            modifiers: ['public'], returnType: 'int', name: 'get',
            params: [{ type: 'int', name: 'x' }, { type: 'int', name: 'y' }],
            body: [
              'if (x < 0 || y < 0 || x >= width || y >= height) {',
              '    return 0;',
              '}',
              'return pixels[y * width + x];'
            ].join('\n')
          }
        ]
      },
      imports: []
    };
  },

  /** Parallel chunked loops over an int range (ForkJoin-backed streams). */
  parallel(params = {}) {
    const name = requiredName(params);
    return {
      ops: {
        class: { name, modifiers: ['public', 'final'] },
        constructors: [{ modifiers: ['private'], params: [], body: '' }],
        methods: [
          {
            modifiers: ['public', 'static'], returnType: 'void', name: 'forEachChunked',
            params: [
              { type: 'int', name: 'fromInclusive' },
              { type: 'int', name: 'toExclusive' },
              { type: 'int', name: 'chunkSize' },
              { type: 'IntConsumer', name: 'task' }
            ],
            body: [
              'int chunks = (int) Math.ceil((toExclusive - fromInclusive) / (double) chunkSize);',
              'IntStream.range(0, chunks).parallel().forEach((chunk) -> {',
              '    int start = fromInclusive + chunk * chunkSize;',
              '    int end = Math.min(toExclusive, start + chunkSize);',
              '    for (int i = start; i < end; i++) {',
              '        task.accept(i);',
              '    }',
              '});'
            ].join('\n')
          },
          {
            modifiers: ['public', 'static'], returnType: 'long', name: 'sum',
            params: [
              { type: 'int', name: 'fromInclusive' },
              { type: 'int', name: 'toExclusive' },
              { type: 'int', name: 'chunkSize' },
              { type: 'IntToLongFunction', name: 'fn' }
            ],
            body: [
              'int chunks = (int) Math.ceil((toExclusive - fromInclusive) / (double) chunkSize);',
              'return IntStream.range(0, chunks).parallel().mapToLong((chunk) -> {',
              '    int start = fromInclusive + chunk * chunkSize;',
              '    int end = Math.min(toExclusive, start + chunkSize);',
              '    long sum = 0L;',
              '    for (int i = start; i < end; i++) {',
              '        sum += fn.applyAsLong(i);',
              '    }',
              '    return sum;',
              '}).sum();'
            ].join('\n')
          }
        ]
      },
      imports: ['java.util.stream.IntStream', 'java.util.function.IntConsumer', 'java.util.function.IntToLongFunction']
    };
  },

  /** Off-heap linear arena over a direct ByteBuffer. */
  arena(params = {}) {
    const name = requiredName(params);
    return {
      ops: {
        class: { name, modifiers: ['public', 'final'], implements: ['AutoCloseable'] },
        fields: [
          { modifiers: ['private', 'final'], type: 'ByteBuffer', name: 'buffer' },
          { modifiers: ['private'], type: 'int', name: 'offset' }
        ],
        constructors: [{
          modifiers: ['public'],
          params: [{ type: 'int', name: 'capacityBytes' }],
          body: 'buffer = ByteBuffer.allocateDirect(capacityBytes).order(ByteOrder.nativeOrder());'
        }],
        methods: [
          {
            modifiers: ['public'], returnType: 'int', name: 'allocate',
            params: [{ type: 'int', name: 'bytes' }, { type: 'int', name: 'alignment' }],
            body: [
              'int aligned = (offset + alignment - 1) & ~(alignment - 1);',
              'if (aligned + bytes > buffer.capacity()) {',
              '    throw new IndexOutOfBoundsException("arena exhausted: " + buffer.capacity() + " bytes");',
              '}',
              'offset = aligned + bytes;',
              'return aligned;'
            ].join('\n')
          },
          {
            modifiers: ['public'], returnType: 'ByteBuffer', name: 'buffer', params: [],
            body: 'return buffer;'
          },
          {
            modifiers: ['public'], returnType: 'int', name: 'used', params: [],
            body: 'return offset;'
          },
          {
            modifiers: ['public'], returnType: 'void', name: 'reset', params: [],
            body: 'offset = 0;'
          },
          {
            modifiers: ['public'], returnType: 'void', name: 'close', params: [],
            annotations: ['Override'], body: ''
          }
        ]
      },
      imports: ['java.nio.ByteBuffer', 'java.nio.ByteOrder']
    };
  },

  /** LWJGL 3 + GLFW window and render loop skeleton. */
  lwjgl(params = {}) {
    const name = requiredName(params);
    const title = params.title || name;
    const width = params.width || 1280;
    const height = params.height || 720;
    return {
      ops: {
        class: { name, modifiers: ['public', 'final'] },
        fields: [{ modifiers: ['private'], type: 'long', name: 'window' }],
        methods: [
          {
            modifiers: ['public'], returnType: 'void', name: 'run', params: [],
            body: [
              'GLFWErrorCallback.createPrint(System.err).set();',
              'if (!GLFW.glfwInit()) {',
              '    throw new IllegalStateException("unable to initialize GLFW");',
              '}',
              `window = GLFW.glfwCreateWindow(${width}, ${height}, "${title}", MemoryUtil.NULL, MemoryUtil.NULL);`,
              'if (window == MemoryUtil.NULL) {',
              '    throw new IllegalStateException("unable to create GLFW window");',
              '}',
              'GLFW.glfwMakeContextCurrent(window);',
              'GLFW.glfwSwapInterval(1);',
              'GL.createCapabilities();',
              'GLFW.glfwShowWindow(window);',
              'try {',
              '    while (!GLFW.glfwWindowShouldClose(window)) {',
              '        GL11.glClearColor(0.05f, 0.05f, 0.08f, 1.0f);',
              '        GL11.glClear(GL11.GL_COLOR_BUFFER_BIT | GL11.GL_DEPTH_BUFFER_BIT);',
              '        render();',
              '        GLFW.glfwSwapBuffers(window);',
              '        GLFW.glfwPollEvents();',
              '    }',
              '} finally {',
              '    GLFW.glfwDestroyWindow(window);',
              '    GLFW.glfwTerminate();',
              '}'
            ].join('\n')
          },
          {
            modifiers: ['protected'], returnType: 'void', name: 'render', params: [], body: ''
          },
          {
            modifiers: ['public', 'static'], returnType: 'void', name: 'main',
            params: [{ type: 'String[]', name: 'args' }],
            body: `new ${name}().run();`
          }
        ]
      },
      imports: [
        'org.lwjgl.glfw.GLFW',
        'org.lwjgl.glfw.GLFWErrorCallback',
        'org.lwjgl.opengl.GL',
        'org.lwjgl.opengl.GL11',
        'org.lwjgl.system.MemoryUtil'
      ]
    };
  },

  /** Deterministic value noise for procedural content. */
  noise(params = {}) {
    const name = requiredName(params);
    return {
      ops: {
        class: { name, modifiers: ['public', 'final'] },
        fields: [{ modifiers: ['private', 'final'], type: 'int[]', name: 'perm' }],
        constructors: [{
          modifiers: ['public'],
          params: [{ type: 'long', name: 'seed' }],
          body: [
            'Random random = new Random(seed);',
            'int[] p = new int[256];',
            'for (int i = 0; i < 256; i++) {',
            '    p[i] = i;',
            '}',
            'for (int i = 255; i > 0; i--) {',
            '    int j = random.nextInt(i + 1);',
            '    int t = p[i];',
            '    p[i] = p[j];',
            '    p[j] = t;',
            '}',
            'perm = new int[512];',
            'for (int i = 0; i < 512; i++) {',
            '    perm[i] = p[i & 255];',
            '}'
          ].join('\n')
        }],
        methods: [
          {
            modifiers: ['public'], returnType: 'float', name: 'noise2',
            params: [{ type: 'float', name: 'x' }, { type: 'float', name: 'y' }],
            body: [
              'int xi = (int) Math.floor(x);',
              'int yi = (int) Math.floor(y);',
              'float xf = x - xi;',
              'float yf = y - yi;',
              'float u = fade(xf);',
              'float v = fade(yf);',
              'float a = lerp(u, value(xi, yi), value(xi + 1, yi));',
              'float b = lerp(u, value(xi, yi + 1), value(xi + 1, yi + 1));',
              'return lerp(v, a, b);'
            ].join('\n')
          },
          {
            modifiers: ['private'], returnType: 'float', name: 'fade',
            params: [{ type: 'float', name: 't' }],
            body: 'return t * t * t * (t * (t * 6f - 15f) + 10f);'
          },
          {
            modifiers: ['private'], returnType: 'float', name: 'lerp',
            params: [{ type: 'float', name: 't' }, { type: 'float', name: 'a' }, { type: 'float', name: 'b' }],
            body: 'return a + t * (b - a);'
          },
          {
            modifiers: ['private'], returnType: 'float', name: 'value',
            params: [{ type: 'int', name: 'x' }, { type: 'int', name: 'y' }],
            body: [
              'int h = perm[(x & 255) + perm[y & 255]];',
              'h = (h * 1103515245 + 12345) & 0x7fffffff;',
              'return h / (float) 0x7fffffff;'
            ].join('\n')
          }
        ]
      },
      imports: ['java.util.Random']
    };
  }
};

/**
 * Resolve a preset name into concrete ops.
 * @param {string} name
 * @param {object} params
 * @returns {{ops:object, imports:string[]}}
 */
export function resolvePreset(name, params = {}) {
  const preset = PRESETS[name];
  if (!preset) {
    throw new Error(`unknown intent "${name}"; available: ${Object.keys(PRESETS).join(', ')}`);
  }
  return preset(params);
}

/** @returns {string[]} */
export function listPresets() {
  return Object.keys(PRESETS);
}

export { PRESETS };
