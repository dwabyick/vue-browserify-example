(function e(t,n,r){function s(o,u){if(!n[o]){if(!t[o]){var a=typeof require=="function"&&require;if(!u&&a)return a(o,!0);if(i)return i(o,!0);throw new Error("Cannot find module '"+o+"'")}var f=n[o]={exports:{}};t[o][0].call(f.exports,function(e){var n=t[o][1][e];return s(n?n:e)},f,f.exports,e,t,n,r)}return n[o].exports}var i=typeof require=="function"&&require;for(var o=0;o<r.length;o++)s(r[o]);return s})({1:[function(require,module,exports){
var inserted = {};

module.exports = function (css) {
    if (inserted[css]) return;
    inserted[css] = true;
    
    var elem = document.createElement('style');
    elem.setAttribute('type', 'text/css');

    if ('textContent' in elem) {
      elem.textContent = css;
    } else {
      elem.styleSheet.cssText = css;
    }
    
    var head = document.getElementsByTagName('head')[0];
    head.appendChild(elem);
};

},{}],2:[function(require,module,exports){
var utils = require('./utils')

function Batcher () {
    this.reset()
}

var BatcherProto = Batcher.prototype

BatcherProto.push = function (job) {
    if (!job.id || !this.has[job.id]) {
        this.queue.push(job)
        this.has[job.id] = job
        if (!this.waiting) {
            this.waiting = true
            utils.nextTick(utils.bind(this.flush, this))
        }
    } else if (job.override) {
        var oldJob = this.has[job.id]
        oldJob.cancelled = true
        this.queue.push(job)
        this.has[job.id] = job
    }
}

BatcherProto.flush = function () {
    // before flush hook
    if (this._preFlush) this._preFlush()
    // do not cache length because more jobs might be pushed
    // as we execute existing jobs
    for (var i = 0; i < this.queue.length; i++) {
        var job = this.queue[i]
        if (!job.cancelled) {
            job.execute()
        }
    }
    this.reset()
}

BatcherProto.reset = function () {
    this.has = utils.hash()
    this.queue = []
    this.waiting = false
}

module.exports = Batcher
},{"./utils":25}],3:[function(require,module,exports){
var Batcher        = require('./batcher'),
    bindingBatcher = new Batcher(),
    bindingId      = 1

/**
 *  Binding class.
 *
 *  each property on the viewmodel has one corresponding Binding object
 *  which has multiple directive instances on the DOM
 *  and multiple computed property dependents
 */
function Binding (compiler, key, isExp, isFn) {
    this.id = bindingId++
    this.value = undefined
    this.isExp = !!isExp
    this.isFn = isFn
    this.root = !this.isExp && key.indexOf('.') === -1
    this.compiler = compiler
    this.key = key
    this.dirs = []
    this.subs = []
    this.deps = []
    this.unbound = false
}

var BindingProto = Binding.prototype

/**
 *  Update value and queue instance updates.
 */
BindingProto.update = function (value) {
    if (!this.isComputed || this.isFn) {
        this.value = value
    }
    if (this.dirs.length || this.subs.length) {
        var self = this
        bindingBatcher.push({
            id: this.id,
            execute: function () {
                if (!self.unbound) {
                    self._update()
                }
            }
        })
    }
}

/**
 *  Actually update the directives.
 */
BindingProto._update = function () {
    var i = this.dirs.length,
        value = this.val()
    while (i--) {
        this.dirs[i].update(value)
    }
    this.pub()
}

/**
 *  Return the valuated value regardless
 *  of whether it is computed or not
 */
BindingProto.val = function () {
    return this.isComputed && !this.isFn
        ? this.value.$get()
        : this.value
}

/**
 *  Notify computed properties that depend on this binding
 *  to update themselves
 */
BindingProto.pub = function () {
    var i = this.subs.length
    while (i--) {
        this.subs[i].update()
    }
}

/**
 *  Unbind the binding, remove itself from all of its dependencies
 */
BindingProto.unbind = function () {
    // Indicate this has been unbound.
    // It's possible this binding will be in
    // the batcher's flush queue when its owner
    // compiler has already been destroyed.
    this.unbound = true
    var i = this.dirs.length
    while (i--) {
        this.dirs[i].unbind()
    }
    i = this.deps.length
    var subs
    while (i--) {
        subs = this.deps[i].subs
        var j = subs.indexOf(this)
        if (j > -1) subs.splice(j, 1)
    }
}

module.exports = Binding
},{"./batcher":2}],4:[function(require,module,exports){
var Emitter     = require('./emitter'),
    Observer    = require('./observer'),
    config      = require('./config'),
    utils       = require('./utils'),
    Binding     = require('./binding'),
    Directive   = require('./directive'),
    TextParser  = require('./text-parser'),
    DepsParser  = require('./deps-parser'),
    ExpParser   = require('./exp-parser'),
    ViewModel,
    
    // cache methods
    slice       = [].slice,
    extend      = utils.extend,
    hasOwn      = ({}).hasOwnProperty,
    def         = Object.defineProperty,

    // hooks to register
    hooks = [
        'created', 'ready',
        'beforeDestroy', 'afterDestroy',
        'attached', 'detached'
    ],

    // list of priority directives
    // that needs to be checked in specific order
    priorityDirectives = [
        'if',
        'repeat',
        'view',
        'component'
    ]

/**
 *  The DOM compiler
 *  scans a DOM node and compile bindings for a ViewModel
 */
function Compiler (vm, options) {

    var compiler = this,
        key, i

    // default state
    compiler.init       = true
    compiler.destroyed  = false

    // process and extend options
    options = compiler.options = options || {}
    utils.processOptions(options)

    // copy compiler options
    extend(compiler, options.compilerOptions)
    // repeat indicates this is a v-repeat instance
    compiler.repeat   = compiler.repeat || false
    // expCache will be shared between v-repeat instances
    compiler.expCache = compiler.expCache || {}

    // initialize element
    var el = compiler.el = compiler.setupElement(options)
    utils.log('\nnew VM instance: ' + el.tagName + '\n')

    // set other compiler properties
    compiler.vm       = el.vue_vm = vm
    compiler.bindings = utils.hash()
    compiler.dirs     = []
    compiler.deferred = []
    compiler.computed = []
    compiler.children = []
    compiler.emitter  = new Emitter(vm)

    // create bindings for computed properties
    if (options.methods) {
        for (key in options.methods) {
            compiler.createBinding(key)
        }
    }

    // create bindings for methods
    if (options.computed) {
        for (key in options.computed) {
            compiler.createBinding(key)
        }
    }

    // VM ---------------------------------------------------------------------

    // set VM properties
    vm.$         = {}
    vm.$el       = el
    vm.$options  = options
    vm.$compiler = compiler
    vm.$event    = null

    // set parent & root
    var parentVM = options.parent
    if (parentVM) {
        compiler.parent = parentVM.$compiler
        parentVM.$compiler.children.push(compiler)
        vm.$parent = parentVM
    }
    vm.$root = getRoot(compiler).vm

    // DATA -------------------------------------------------------------------

    // setup observer
    // this is necesarry for all hooks and data observation events
    compiler.setupObserver()

    // initialize data
    var data = compiler.data = options.data || {},
        defaultData = options.defaultData
    if (defaultData) {
        for (key in defaultData) {
            if (!hasOwn.call(data, key)) {
                data[key] = defaultData[key]
            }
        }
    }

    // copy paramAttributes
    var params = options.paramAttributes
    if (params) {
        i = params.length
        while (i--) {
            data[params[i]] = utils.checkNumber(
                compiler.eval(
                    el.getAttribute(params[i])
                )
            )
        }
    }

    // copy data properties to vm
    // so user can access them in the created hook
    extend(vm, data)
    vm.$data = data

    // beforeCompile hook
    compiler.execHook('created')

    // the user might have swapped the data ...
    data = compiler.data = vm.$data

    // user might also set some properties on the vm
    // in which case we should copy back to $data
    var vmProp
    for (key in vm) {
        vmProp = vm[key]
        if (
            key.charAt(0) !== '$' &&
            data[key] !== vmProp &&
            typeof vmProp !== 'function'
        ) {
            data[key] = vmProp
        }
    }

    // now we can observe the data.
    // this will convert data properties to getter/setters
    // and emit the first batch of set events, which will
    // in turn create the corresponding bindings.
    compiler.observeData(data)

    // COMPILE ----------------------------------------------------------------

    // before compiling, resolve content insertion points
    if (options.template) {
        this.resolveContent()
    }

    // now parse the DOM and bind directives.
    // During this stage, we will also create bindings for
    // encountered keypaths that don't have a binding yet.
    compiler.compile(el, true)

    // Any directive that creates child VMs are deferred
    // so that when they are compiled, all bindings on the
    // parent VM have been created.
    i = compiler.deferred.length
    while (i--) {
        compiler.bindDirective(compiler.deferred[i])
    }
    compiler.deferred = null

    // extract dependencies for computed properties.
    // this will evaluated all collected computed bindings
    // and collect get events that are emitted.
    if (this.computed.length) {
        DepsParser.parse(this.computed)
    }

    // done!
    compiler.init = false

    // post compile / ready hook
    compiler.execHook('ready')
}

var CompilerProto = Compiler.prototype

/**
 *  Initialize the VM/Compiler's element.
 *  Fill it in with the template if necessary.
 */
CompilerProto.setupElement = function (options) {
    // create the node first
    var el = typeof options.el === 'string'
        ? document.querySelector(options.el)
        : options.el || document.createElement(options.tagName || 'div')

    var template = options.template,
        child, replacer, i, attr, attrs

    if (template) {
        // collect anything already in there
        if (el.hasChildNodes()) {
            this.rawContent = document.createElement('div')
            /* jshint boss: true */
            while (child = el.firstChild) {
                this.rawContent.appendChild(child)
            }
        }
        // replace option: use the first node in
        // the template directly
        if (options.replace && template.childNodes.length === 1) {
            replacer = template.childNodes[0].cloneNode(true)
            if (el.parentNode) {
                el.parentNode.insertBefore(replacer, el)
                el.parentNode.removeChild(el)
            }
            // copy over attributes
            if (el.hasAttributes()) {
                i = el.attributes.length
                while (i--) {
                    attr = el.attributes[i]
                    replacer.setAttribute(attr.name, attr.value)
                }
            }
            // replace
            el = replacer
        } else {
            el.appendChild(template.cloneNode(true))
        }

    }

    // apply element options
    if (options.id) el.id = options.id
    if (options.className) el.className = options.className
    attrs = options.attributes
    if (attrs) {
        for (attr in attrs) {
            el.setAttribute(attr, attrs[attr])
        }
    }

    return el
}

/**
 *  Deal with <content> insertion points
 *  per the Web Components spec
 */
CompilerProto.resolveContent = function () {

    var outlets = slice.call(this.el.getElementsByTagName('content')),
        raw = this.rawContent,
        outlet, select, i, j, main

    i = outlets.length
    if (i) {
        // first pass, collect corresponding content
        // for each outlet.
        while (i--) {
            outlet = outlets[i]
            if (raw) {
                select = outlet.getAttribute('select')
                if (select) { // select content
                    outlet.content =
                        slice.call(raw.querySelectorAll(select))
                } else { // default content
                    main = outlet
                }
            } else { // fallback content
                outlet.content =
                    slice.call(outlet.childNodes)
            }
        }
        // second pass, actually insert the contents
        for (i = 0, j = outlets.length; i < j; i++) {
            outlet = outlets[i]
            if (outlet === main) continue
            insert(outlet, outlet.content)
        }
        // finally insert the main content
        if (raw && main) {
            insert(main, slice.call(raw.childNodes))
        }
    }

    function insert (outlet, contents) {
        var parent = outlet.parentNode,
            i = 0, j = contents.length
        for (; i < j; i++) {
            parent.insertBefore(contents[i], outlet)
        }
        parent.removeChild(outlet)
    }

    this.rawContent = null
}

/**
 *  Setup observer.
 *  The observer listens for get/set/mutate events on all VM
 *  values/objects and trigger corresponding binding updates.
 *  It also listens for lifecycle hooks.
 */
CompilerProto.setupObserver = function () {

    var compiler = this,
        bindings = compiler.bindings,
        options  = compiler.options,
        observer = compiler.observer = new Emitter(compiler.vm)

    // a hash to hold event proxies for each root level key
    // so they can be referenced and removed later
    observer.proxies = {}

    // add own listeners which trigger binding updates
    observer
        .on('get', onGet)
        .on('set', onSet)
        .on('mutate', onSet)

    // register hooks
    var i = hooks.length, j, hook, fns
    while (i--) {
        hook = hooks[i]
        fns = options[hook]
        if (Array.isArray(fns)) {
            j = fns.length
            // since hooks were merged with child at head,
            // we loop reversely.
            while (j--) {
                registerHook(hook, fns[j])
            }
        } else if (fns) {
            registerHook(hook, fns)
        }
    }

    // broadcast attached/detached hooks
    observer
        .on('hook:attached', function () {
            broadcast(1)
        })
        .on('hook:detached', function () {
            broadcast(0)
        })

    function onGet (key) {
        check(key)
        DepsParser.catcher.emit('get', bindings[key])
    }

    function onSet (key, val, mutation) {
        observer.emit('change:' + key, val, mutation)
        check(key)
        bindings[key].update(val)
    }

    function registerHook (hook, fn) {
        observer.on('hook:' + hook, function () {
            fn.call(compiler.vm)
        })
    }

    function broadcast (event) {
        var children = compiler.children
        if (children) {
            var child, i = children.length
            while (i--) {
                child = children[i]
                if (child.el.parentNode) {
                    event = 'hook:' + (event ? 'attached' : 'detached')
                    child.observer.emit(event)
                    child.emitter.emit(event)
                }
            }
        }
    }

    function check (key) {
        if (!bindings[key]) {
            compiler.createBinding(key)
        }
    }
}

CompilerProto.observeData = function (data) {

    var compiler = this,
        observer = compiler.observer

    // recursively observe nested properties
    Observer.observe(data, '', observer)

    // also create binding for top level $data
    // so it can be used in templates too
    var $dataBinding = compiler.bindings['$data'] = new Binding(compiler, '$data')
    $dataBinding.update(data)

    // allow $data to be swapped
    def(compiler.vm, '$data', {
        get: function () {
            compiler.observer.emit('get', '$data')
            return compiler.data
        },
        set: function (newData) {
            var oldData = compiler.data
            Observer.unobserve(oldData, '', observer)
            compiler.data = newData
            Observer.copyPaths(newData, oldData)
            Observer.observe(newData, '', observer)
            update()
        }
    })

    // emit $data change on all changes
    observer
        .on('set', onSet)
        .on('mutate', onSet)

    function onSet (key) {
        if (key !== '$data') update()
    }

    function update () {
        $dataBinding.update(compiler.data)
        observer.emit('change:$data', compiler.data)
    }
}

/**
 *  Compile a DOM node (recursive)
 */
CompilerProto.compile = function (node, root) {
    var nodeType = node.nodeType
    if (nodeType === 1 && node.tagName !== 'SCRIPT') { // a normal node
        this.compileElement(node, root)
    } else if (nodeType === 3 && config.interpolate) {
        this.compileTextNode(node)
    }
}

/**
 *  Check for a priority directive
 *  If it is present and valid, return true to skip the rest
 */
CompilerProto.checkPriorityDir = function (dirname, node, root) {
    var expression, directive, Ctor
    if (
        dirname === 'component' &&
        root !== true &&
        (Ctor = this.resolveComponent(node, undefined, true))
    ) {
        directive = this.parseDirective(dirname, '', node)
        directive.Ctor = Ctor
    } else {
        expression = utils.attr(node, dirname)
        directive = expression && this.parseDirective(dirname, expression, node)
    }
    if (directive) {
        if (root === true) {
            utils.warn(
                'Directive v-' + dirname + ' cannot be used on an already instantiated ' +
                'VM\'s root node. Use it from the parent\'s template instead.'
            )
            return
        }
        this.deferred.push(directive)
        return true
    }
}

/**
 *  Compile normal directives on a node
 */
CompilerProto.compileElement = function (node, root) {

    // textarea is pretty annoying
    // because its value creates childNodes which
    // we don't want to compile.
    if (node.tagName === 'TEXTAREA' && node.value) {
        node.value = this.eval(node.value)
    }

    // only compile if this element has attributes
    // or its tagName contains a hyphen (which means it could
    // potentially be a custom element)
    if (node.hasAttributes() || node.tagName.indexOf('-') > -1) {

        // skip anything with v-pre
        if (utils.attr(node, 'pre') !== null) {
            return
        }

        var i, l, j, k

        // check priority directives.
        // if any of them are present, it will take over the node with a childVM
        // so we can skip the rest
        for (i = 0, l = priorityDirectives.length; i < l; i++) {
            if (this.checkPriorityDir(priorityDirectives[i], node, root)) {
                return
            }
        }

        // check transition & animation properties
        node.vue_trans  = utils.attr(node, 'transition')
        node.vue_anim   = utils.attr(node, 'animation')
        node.vue_effect = this.eval(utils.attr(node, 'effect'))

        var prefix = config.prefix + '-',
            attrs = slice.call(node.attributes),
            params = this.options.paramAttributes,
            attr, isDirective, exp, directives, directive, dirname

        for (i = 0, l = attrs.length; i < l; i++) {

            attr = attrs[i]
            isDirective = false

            if (attr.name.indexOf(prefix) === 0) {
                // a directive - split, parse and bind it.
                isDirective = true
                dirname = attr.name.slice(prefix.length)
                // build with multiple: true
                directives = this.parseDirective(dirname, attr.value, node, true)
                // loop through clauses (separated by ",")
                // inside each attribute
                for (j = 0, k = directives.length; j < k; j++) {
                    directive = directives[j]
                    if (dirname === 'with') {
                        this.bindDirective(directive, this.parent)
                    } else {
                        this.bindDirective(directive)
                    }
                }
            } else if (config.interpolate) {
                // non directive attribute, check interpolation tags
                exp = TextParser.parseAttr(attr.value)
                if (exp) {
                    directive = this.parseDirective('attr', attr.name + ':' + exp, node)
                    if (params && params.indexOf(attr.name) > -1) {
                        // a param attribute... we should use the parent binding
                        // to avoid circular updates like size={{size}}
                        this.bindDirective(directive, this.parent)
                    } else {
                        this.bindDirective(directive)
                    }
                }
            }

            if (isDirective && dirname !== 'cloak') {
                node.removeAttribute(attr.name)
            }
        }

    }

    // recursively compile childNodes
    if (node.hasChildNodes()) {
        slice.call(node.childNodes).forEach(this.compile, this)
    }
}

/**
 *  Compile a text node
 */
CompilerProto.compileTextNode = function (node) {

    var tokens = TextParser.parse(node.nodeValue)
    if (!tokens) return
    var el, token, directive

    for (var i = 0, l = tokens.length; i < l; i++) {

        token = tokens[i]
        directive = null

        if (token.key) { // a binding
            if (token.key.charAt(0) === '>') { // a partial
                el = document.createComment('ref')
                directive = this.parseDirective('partial', token.key.slice(1), el)
            } else {
                if (!token.html) { // text binding
                    el = document.createTextNode('')
                    directive = this.parseDirective('text', token.key, el)
                } else { // html binding
                    el = document.createComment(config.prefix + '-html')
                    directive = this.parseDirective('html', token.key, el)
                }
            }
        } else { // a plain string
            el = document.createTextNode(token)
        }

        // insert node
        node.parentNode.insertBefore(el, node)
        // bind directive
        this.bindDirective(directive)

    }
    node.parentNode.removeChild(node)
}

/**
 *  Parse a directive name/value pair into one or more
 *  directive instances
 */
CompilerProto.parseDirective = function (name, value, el, multiple) {
    var compiler = this,
        definition = compiler.getOption('directives', name)
    if (definition) {
        // parse into AST-like objects
        var asts = Directive.parse(value)
        return multiple
            ? asts.map(build)
            : build(asts[0])
    }
    function build (ast) {
        return new Directive(name, ast, definition, compiler, el)
    }
}

/**
 *  Add a directive instance to the correct binding & viewmodel
 */
CompilerProto.bindDirective = function (directive, bindingOwner) {

    if (!directive) return

    // keep track of it so we can unbind() later
    this.dirs.push(directive)

    // for empty or literal directives, simply call its bind()
    // and we're done.
    if (directive.isEmpty || directive.isLiteral) {
        if (directive.bind) directive.bind()
        return
    }

    // otherwise, we got more work to do...
    var binding,
        compiler = bindingOwner || this,
        key      = directive.key

    if (directive.isExp) {
        // expression bindings are always created on current compiler
        binding = compiler.createBinding(key, directive)
    } else {
        // recursively locate which compiler owns the binding
        while (compiler) {
            if (compiler.hasKey(key)) {
                break
            } else {
                compiler = compiler.parent
            }
        }
        compiler = compiler || this
        binding = compiler.bindings[key] || compiler.createBinding(key)
    }
    binding.dirs.push(directive)
    directive.binding = binding

    var value = binding.val()
    // invoke bind hook if exists
    if (directive.bind) {
        directive.bind(value)
    }
    // set initial value
    directive.update(value, true)
}

/**
 *  Create binding and attach getter/setter for a key to the viewmodel object
 */
CompilerProto.createBinding = function (key, directive) {

    utils.log('  created binding: ' + key)

    var compiler = this,
        methods  = compiler.options.methods,
        isExp    = directive && directive.isExp,
        isFn     = (directive && directive.isFn) || (methods && methods[key]),
        bindings = compiler.bindings,
        computed = compiler.options.computed,
        binding  = new Binding(compiler, key, isExp, isFn)

    if (isExp) {
        // expression bindings are anonymous
        compiler.defineExp(key, binding, directive)
    } else if (isFn) {
        bindings[key] = binding
        binding.value = compiler.vm[key] = methods[key]
    } else {
        bindings[key] = binding
        if (binding.root) {
            // this is a root level binding. we need to define getter/setters for it.
            if (computed && computed[key]) {
                // computed property
                compiler.defineComputed(key, binding, computed[key])
            } else if (key.charAt(0) !== '$') {
                // normal property
                compiler.defineProp(key, binding)
            } else {
                compiler.defineMeta(key, binding)
            }
        } else if (computed && computed[utils.baseKey(key)]) {
            // nested path on computed property
            compiler.defineExp(key, binding)
        } else {
            // ensure path in data so that computed properties that
            // access the path don't throw an error and can collect
            // dependencies
            Observer.ensurePath(compiler.data, key)
            var parentKey = key.slice(0, key.lastIndexOf('.'))
            if (!bindings[parentKey]) {
                // this is a nested value binding, but the binding for its parent
                // has not been created yet. We better create that one too.
                compiler.createBinding(parentKey)
            }
        }
    }
    return binding
}

/**
 *  Define the getter/setter for a root-level property on the VM
 *  and observe the initial value
 */
CompilerProto.defineProp = function (key, binding) {
    var compiler = this,
        data     = compiler.data,
        ob       = data.__emitter__

    // make sure the key is present in data
    // so it can be observed
    if (!(hasOwn.call(data, key))) {
        data[key] = undefined
    }

    // if the data object is already observed, but the key
    // is not observed, we need to add it to the observed keys.
    if (ob && !(hasOwn.call(ob.values, key))) {
        Observer.convertKey(data, key)
    }

    binding.value = data[key]

    def(compiler.vm, key, {
        get: function () {
            return compiler.data[key]
        },
        set: function (val) {
            compiler.data[key] = val
        }
    })
}

/**
 *  Define a meta property, e.g. $index or $key,
 *  which is bindable but only accessible on the VM,
 *  not in the data.
 */
CompilerProto.defineMeta = function (key, binding) {
    var ob = this.observer
    binding.value = this.data[key]
    delete this.data[key]
    def(this.vm, key, {
        get: function () {
            if (Observer.shouldGet) ob.emit('get', key)
            return binding.value
        },
        set: function (val) {
            ob.emit('set', key, val)
        }
    })
}

/**
 *  Define an expression binding, which is essentially
 *  an anonymous computed property
 */
CompilerProto.defineExp = function (key, binding, directive) {
    var computedKey = directive && directive.computedKey,
        exp         = computedKey ? directive.expression : key,
        getter      = this.expCache[exp]
    if (!getter) {
        getter = this.expCache[exp] = ExpParser.parse(computedKey || key, this)
    }
    if (getter) {
        this.markComputed(binding, getter)
    }
}

/**
 *  Define a computed property on the VM
 */
CompilerProto.defineComputed = function (key, binding, value) {
    this.markComputed(binding, value)
    def(this.vm, key, {
        get: binding.value.$get,
        set: binding.value.$set
    })
}

/**
 *  Process a computed property binding
 *  so its getter/setter are bound to proper context
 */
CompilerProto.markComputed = function (binding, value) {
    binding.isComputed = true
    // bind the accessors to the vm
    if (binding.isFn) {
        binding.value = value
    } else {
        if (typeof value === 'function') {
            value = { $get: value }
        }
        binding.value = {
            $get: utils.bind(value.$get, this.vm),
            $set: value.$set
                ? utils.bind(value.$set, this.vm)
                : undefined
        }
    }
    // keep track for dep parsing later
    this.computed.push(binding)
}

/**
 *  Retrive an option from the compiler
 */
CompilerProto.getOption = function (type, id, silent) {
    var opts = this.options,
        parent = this.parent,
        globalAssets = config.globalAssets,
        res = (opts[type] && opts[type][id]) || (
            parent
                ? parent.getOption(type, id, silent)
                : globalAssets[type] && globalAssets[type][id]
        )
    if (!res && !silent && typeof id === 'string') {
        utils.warn('Unknown ' + type.slice(0, -1) + ': ' + id)
    }
    return res
}

/**
 *  Emit lifecycle events to trigger hooks
 */
CompilerProto.execHook = function (event) {
    event = 'hook:' + event
    this.observer.emit(event)
    this.emitter.emit(event)
}

/**
 *  Check if a compiler's data contains a keypath
 */
CompilerProto.hasKey = function (key) {
    var baseKey = utils.baseKey(key)
    return hasOwn.call(this.data, baseKey) ||
        hasOwn.call(this.vm, baseKey)
}

/**
 *  Do a one-time eval of a string that potentially
 *  includes bindings. It accepts additional raw data
 *  because we need to dynamically resolve v-component
 *  before a childVM is even compiled...
 */
CompilerProto.eval = function (exp, data) {
    var parsed = TextParser.parseAttr(exp)
    return parsed
        ? ExpParser.eval(parsed, this, data)
        : exp
}

/**
 *  Resolve a Component constructor for an element
 *  with the data to be used
 */
CompilerProto.resolveComponent = function (node, data, test) {

    // late require to avoid circular deps
    ViewModel = ViewModel || require('./viewmodel')

    var exp     = utils.attr(node, 'component'),
        tagName = node.tagName,
        id      = this.eval(exp, data),
        tagId   = (tagName.indexOf('-') > 0 && tagName.toLowerCase()),
        Ctor    = this.getOption('components', id || tagId, true)

    if (id && !Ctor) {
        utils.warn('Unknown component: ' + id)
    }

    return test
        ? exp === ''
            ? ViewModel
            : Ctor
        : Ctor || ViewModel
}

/**
 *  Unbind and remove element
 */
CompilerProto.destroy = function () {

    // avoid being called more than once
    // this is irreversible!
    if (this.destroyed) return

    var compiler = this,
        i, j, key, dir, dirs, binding,
        vm          = compiler.vm,
        el          = compiler.el,
        directives  = compiler.dirs,
        computed    = compiler.computed,
        bindings    = compiler.bindings,
        children    = compiler.children,
        parent      = compiler.parent

    compiler.execHook('beforeDestroy')

    // unobserve data
    Observer.unobserve(compiler.data, '', compiler.observer)

    // unbind all direcitves
    i = directives.length
    while (i--) {
        dir = directives[i]
        // if this directive is an instance of an external binding
        // e.g. a directive that refers to a variable on the parent VM
        // we need to remove it from that binding's directives
        // * empty and literal bindings do not have binding.
        if (dir.binding && dir.binding.compiler !== compiler) {
            dirs = dir.binding.dirs
            if (dirs) {
                j = dirs.indexOf(dir)
                if (j > -1) dirs.splice(j, 1)
            }
        }
        dir.unbind()
    }

    // unbind all computed, anonymous bindings
    i = computed.length
    while (i--) {
        computed[i].unbind()
    }

    // unbind all keypath bindings
    for (key in bindings) {
        binding = bindings[key]
        if (binding) {
            binding.unbind()
        }
    }

    // destroy all children
    i = children.length
    while (i--) {
        children[i].destroy()
    }

    // remove self from parent
    if (parent) {
        j = parent.children.indexOf(compiler)
        if (j > -1) parent.children.splice(j, 1)
    }

    // finally remove dom element
    if (el === document.body) {
        el.innerHTML = ''
    } else {
        vm.$remove()
    }
    el.vue_vm = null

    compiler.destroyed = true
    // emit destroy hook
    compiler.execHook('afterDestroy')

    // finally, unregister all listeners
    compiler.observer.off()
    compiler.emitter.off()
}

// Helpers --------------------------------------------------------------------

/**
 *  shorthand for getting root compiler
 */
function getRoot (compiler) {
    while (compiler.parent) {
        compiler = compiler.parent
    }
    return compiler
}

module.exports = Compiler
},{"./binding":3,"./config":5,"./deps-parser":6,"./directive":7,"./emitter":18,"./exp-parser":19,"./observer":22,"./text-parser":23,"./utils":25,"./viewmodel":26}],5:[function(require,module,exports){
var TextParser = require('./text-parser')

module.exports = {
    prefix         : 'v',
    debug          : false,
    silent         : false,
    enterClass     : 'v-enter',
    leaveClass     : 'v-leave',
    interpolate    : true
}

Object.defineProperty(module.exports, 'delimiters', {
    get: function () {
        return TextParser.delimiters
    },
    set: function (delimiters) {
        TextParser.setDelimiters(delimiters)
    }
})
},{"./text-parser":23}],6:[function(require,module,exports){
var Emitter  = require('./emitter'),
    utils    = require('./utils'),
    Observer = require('./observer'),
    catcher  = new Emitter()

/**
 *  Auto-extract the dependencies of a computed property
 *  by recording the getters triggered when evaluating it.
 */
function catchDeps (binding) {
    if (binding.isFn) return
    utils.log('\n- ' + binding.key)
    var got = utils.hash()
    binding.deps = []
    catcher.on('get', function (dep) {
        var has = got[dep.key]
        if (
            // avoid duplicate bindings
            (has && has.compiler === dep.compiler) ||
            // avoid repeated items as dependency
            // only when the binding is from self or the parent chain
            (dep.compiler.repeat && !isParentOf(dep.compiler, binding.compiler))
        ) {
            return
        }
        got[dep.key] = dep
        utils.log('  - ' + dep.key)
        binding.deps.push(dep)
        dep.subs.push(binding)
    })
    binding.value.$get()
    catcher.off('get')
}

/**
 *  Test if A is a parent of or equals B
 */
function isParentOf (a, b) {
    while (b) {
        if (a === b) {
            return true
        }
        b = b.parent
    }
}

module.exports = {

    /**
     *  the observer that catches events triggered by getters
     */
    catcher: catcher,

    /**
     *  parse a list of computed property bindings
     */
    parse: function (bindings) {
        utils.log('\nparsing dependencies...')
        Observer.shouldGet = true
        bindings.forEach(catchDeps)
        Observer.shouldGet = false
        utils.log('\ndone.')
    }
    
}
},{"./emitter":18,"./observer":22,"./utils":25}],7:[function(require,module,exports){
var dirId           = 1,
    ARG_RE          = /^[\w\$-]+$/,
    FILTER_TOKEN_RE = /[^\s'"]+|'[^']+'|"[^"]+"/g,
    NESTING_RE      = /^\$(parent|root)\./,
    SINGLE_VAR_RE   = /^[\w\.$]+$/,
    QUOTE_RE        = /"/g

/**
 *  Directive class
 *  represents a single directive instance in the DOM
 */
function Directive (name, ast, definition, compiler, el) {

    this.id             = dirId++
    this.name           = name
    this.compiler       = compiler
    this.vm             = compiler.vm
    this.el             = el
    this.computeFilters = false
    this.key            = ast.key
    this.arg            = ast.arg
    this.expression     = ast.expression

    var isEmpty = this.expression === ''

    // mix in properties from the directive definition
    if (typeof definition === 'function') {
        this[isEmpty ? 'bind' : '_update'] = definition
    } else {
        for (var prop in definition) {
            if (prop === 'unbind' || prop === 'update') {
                this['_' + prop] = definition[prop]
            } else {
                this[prop] = definition[prop]
            }
        }
    }

    // empty expression, we're done.
    if (isEmpty || this.isEmpty) {
        this.isEmpty = true
        return
    }

    this.expression = (
        this.isLiteral
            ? compiler.eval(this.expression)
            : this.expression
    ).trim()

    var filters = ast.filters,
        filter, fn, i, l, computed
    if (filters) {
        this.filters = []
        for (i = 0, l = filters.length; i < l; i++) {
            filter = filters[i]
            fn = this.compiler.getOption('filters', filter.name)
            if (fn) {
                filter.apply = fn
                this.filters.push(filter)
                if (fn.computed) {
                    computed = true
                }
            }
        }
    }

    if (!this.filters || !this.filters.length) {
        this.filters = null
    }

    if (computed) {
        this.computedKey = Directive.inlineFilters(this.key, this.filters)
        this.filters = null
    }

    this.isExp =
        computed ||
        !SINGLE_VAR_RE.test(this.key) ||
        NESTING_RE.test(this.key)

}

var DirProto = Directive.prototype

/**
 *  called when a new value is set 
 *  for computed properties, this will only be called once
 *  during initialization.
 */
DirProto.update = function (value, init) {
    if (init || value !== this.value || (value && typeof value === 'object')) {
        this.value = value
        if (this._update) {
            this._update(
                this.filters && !this.computeFilters
                    ? this.applyFilters(value)
                    : value,
                init
            )
        }
    }
}

/**
 *  pipe the value through filters
 */
DirProto.applyFilters = function (value) {
    var filtered = value, filter
    for (var i = 0, l = this.filters.length; i < l; i++) {
        filter = this.filters[i]
        filtered = filter.apply.apply(this.vm, [filtered].concat(filter.args))
    }
    return filtered
}

/**
 *  Unbind diretive
 */
DirProto.unbind = function () {
    // this can be called before the el is even assigned...
    if (!this.el || !this.vm) return
    if (this._unbind) this._unbind()
    this.vm = this.el = this.binding = this.compiler = null
}

// Exposed static methods -----------------------------------------------------

/**
 *  Parse a directive string into an Array of
 *  AST-like objects representing directives
 */
Directive.parse = function (str) {

    var inSingle = false,
        inDouble = false,
        curly    = 0,
        square   = 0,
        paren    = 0,
        begin    = 0,
        argIndex = 0,
        dirs     = [],
        dir      = {},
        lastFilterIndex = 0,
        arg

    for (var c, i = 0, l = str.length; i < l; i++) {
        c = str.charAt(i)
        if (inSingle) {
            // check single quote
            if (c === "'") inSingle = !inSingle
        } else if (inDouble) {
            // check double quote
            if (c === '"') inDouble = !inDouble
        } else if (c === ',' && !paren && !curly && !square) {
            // reached the end of a directive
            pushDir()
            // reset & skip the comma
            dir = {}
            begin = argIndex = lastFilterIndex = i + 1
        } else if (c === ':' && !dir.key && !dir.arg) {
            // argument
            arg = str.slice(begin, i).trim()
            if (ARG_RE.test(arg)) {
                argIndex = i + 1
                dir.arg = str.slice(begin, i).trim()
            }
        } else if (c === '|' && str.charAt(i + 1) !== '|' && str.charAt(i - 1) !== '|') {
            if (dir.key === undefined) {
                // first filter, end of key
                lastFilterIndex = i + 1
                dir.key = str.slice(argIndex, i).trim()
            } else {
                // already has filter
                pushFilter()
            }
        } else if (c === '"') {
            inDouble = true
        } else if (c === "'") {
            inSingle = true
        } else if (c === '(') {
            paren++
        } else if (c === ')') {
            paren--
        } else if (c === '[') {
            square++
        } else if (c === ']') {
            square--
        } else if (c === '{') {
            curly++
        } else if (c === '}') {
            curly--
        }
    }
    if (i === 0 || begin !== i) {
        pushDir()
    }

    function pushDir () {
        dir.expression = str.slice(begin, i).trim()
        if (dir.key === undefined) {
            dir.key = str.slice(argIndex, i).trim()
        } else if (lastFilterIndex !== begin) {
            pushFilter()
        }
        if (i === 0 || dir.key) {
            dirs.push(dir)
        }
    }

    function pushFilter () {
        var exp = str.slice(lastFilterIndex, i).trim(),
            filter
        if (exp) {
            filter = {}
            var tokens = exp.match(FILTER_TOKEN_RE)
            filter.name = tokens[0]
            filter.args = tokens.length > 1 ? tokens.slice(1) : null
        }
        if (filter) {
            (dir.filters = dir.filters || []).push(filter)
        }
        lastFilterIndex = i + 1
    }

    return dirs
}

/**
 *  Inline computed filters so they become part
 *  of the expression
 */
Directive.inlineFilters = function (key, filters) {
    var args, filter
    for (var i = 0, l = filters.length; i < l; i++) {
        filter = filters[i]
        args = filter.args
            ? ',"' + filter.args.map(escapeQuote).join('","') + '"'
            : ''
        key = 'this.$compiler.getOption("filters", "' +
                filter.name +
            '").call(this,' +
                key + args +
            ')'
    }
    return key
}

/**
 *  Convert double quotes to single quotes
 *  so they don't mess up the generated function body
 */
function escapeQuote (v) {
    return v.indexOf('"') > -1
        ? v.replace(QUOTE_RE, '\'')
        : v
}

module.exports = Directive
},{}],8:[function(require,module,exports){
var guard = require('../utils').guard,
    slice = [].slice

/**
 *  Binding for innerHTML
 */
module.exports = {

    bind: function () {
        // a comment node means this is a binding for
        // {{{ inline unescaped html }}}
        if (this.el.nodeType === 8) {
            // hold nodes
            this.holder = document.createElement('div')
            this.nodes = []
        }
    },

    update: function (value) {
        value = guard(value)
        if (this.holder) {
            this.swap(value)
        } else {
            this.el.innerHTML = value
        }
    },

    swap: function (value) {
        var parent = this.el.parentNode,
            holder = this.holder,
            nodes = this.nodes,
            i = nodes.length, l
        while (i--) {
            parent.removeChild(nodes[i])
        }
        holder.innerHTML = value
        nodes = this.nodes = slice.call(holder.childNodes)
        for (i = 0, l = nodes.length; i < l; i++) {
            parent.insertBefore(nodes[i], this.el)
        }
    }
}
},{"../utils":25}],9:[function(require,module,exports){
var utils    = require('../utils')

/**
 *  Manages a conditional child VM
 */
module.exports = {

    bind: function () {
        
        this.parent = this.el.parentNode
        this.ref    = document.createComment('vue-if')
        this.Ctor   = this.compiler.resolveComponent(this.el)

        // insert ref
        this.parent.insertBefore(this.ref, this.el)
        this.parent.removeChild(this.el)

        if (utils.attr(this.el, 'view')) {
            utils.warn(
                'Conflict: v-if cannot be used together with v-view. ' +
                'Just set v-view\'s binding value to empty string to empty it.'
            )
        }
        if (utils.attr(this.el, 'repeat')) {
            utils.warn(
                'Conflict: v-if cannot be used together with v-repeat. ' +
                'Use `v-show` or the `filterBy` filter instead.'
            )
        }
    },

    update: function (value) {

        if (!value) {
            this._unbind()
        } else if (!this.childVM) {
            this.childVM = new this.Ctor({
                el: this.el.cloneNode(true),
                parent: this.vm
            })
            if (this.compiler.init) {
                this.parent.insertBefore(this.childVM.$el, this.ref)
            } else {
                this.childVM.$before(this.ref)
            }
        }
        
    },

    unbind: function () {
        if (this.childVM) {
            this.childVM.$destroy()
            this.childVM = null
        }
    }
}
},{"../utils":25}],10:[function(require,module,exports){
var utils      = require('../utils'),
    config     = require('../config'),
    transition = require('../transition'),
    directives = module.exports = utils.hash()

/**
 *  Nest and manage a Child VM
 */
directives.component = {
    isLiteral: true,
    bind: function () {
        if (!this.el.vue_vm) {
            this.childVM = new this.Ctor({
                el: this.el,
                parent: this.vm
            })
        }
    },
    unbind: function () {
        if (this.childVM) {
            this.childVM.$destroy()
        }
    }
}

/**
 *  Binding HTML attributes
 */
directives.attr = {
    bind: function () {
        var params = this.vm.$options.paramAttributes
        this.isParam = params && params.indexOf(this.arg) > -1
    },
    update: function (value) {
        if (value || value === 0) {
            this.el.setAttribute(this.arg, value)
        } else {
            this.el.removeAttribute(this.arg)
        }
        if (this.isParam) {
            this.vm[this.arg] = utils.checkNumber(value)
        }
    }
}

/**
 *  Binding textContent
 */
directives.text = {
    bind: function () {
        this.attr = this.el.nodeType === 3
            ? 'nodeValue'
            : 'textContent'
    },
    update: function (value) {
        this.el[this.attr] = utils.guard(value)
    }
}

/**
 *  Binding CSS display property
 */
directives.show = function (value) {
    var el = this.el,
        target = value ? '' : 'none',
        change = function () {
            el.style.display = target
        }
    transition(el, value ? 1 : -1, change, this.compiler)
}

/**
 *  Binding CSS classes
 */
directives['class'] = function (value) {
    if (this.arg) {
        utils[value ? 'addClass' : 'removeClass'](this.el, this.arg)
    } else {
        if (this.lastVal) {
            utils.removeClass(this.el, this.lastVal)
        }
        if (value) {
            utils.addClass(this.el, value)
            this.lastVal = value
        }
    }
}

/**
 *  Only removed after the owner VM is ready
 */
directives.cloak = {
    isEmpty: true,
    bind: function () {
        var el = this.el
        this.compiler.observer.once('hook:ready', function () {
            el.removeAttribute(config.prefix + '-cloak')
        })
    }
}

/**
 *  Store a reference to self in parent VM's $
 */
directives.ref = {
    isLiteral: true,
    bind: function () {
        var id = this.expression
        if (id) {
            this.vm.$parent.$[id] = this.vm
        }
    },
    unbind: function () {
        var id = this.expression
        if (id) {
            delete this.vm.$parent.$[id]
        }
    }
}

directives.on      = require('./on')
directives.repeat  = require('./repeat')
directives.model   = require('./model')
directives['if']   = require('./if')
directives['with'] = require('./with')
directives.html    = require('./html')
directives.style   = require('./style')
directives.partial = require('./partial')
directives.view    = require('./view')
},{"../config":5,"../transition":24,"../utils":25,"./html":8,"./if":9,"./model":11,"./on":12,"./partial":13,"./repeat":14,"./style":15,"./view":16,"./with":17}],11:[function(require,module,exports){
var utils = require('../utils'),
    isIE9 = navigator.userAgent.indexOf('MSIE 9.0') > 0,
    filter = [].filter

/**
 *  Returns an array of values from a multiple select
 */
function getMultipleSelectOptions (select) {
    return filter
        .call(select.options, function (option) {
            return option.selected
        })
        .map(function (option) {
            return option.value || option.text
        })
}

/**
 *  Two-way binding for form input elements
 */
module.exports = {

    bind: function () {

        var self = this,
            el   = self.el,
            type = el.type,
            tag  = el.tagName

        self.lock = false
        self.ownerVM = self.binding.compiler.vm

        // determine what event to listen to
        self.event =
            (self.compiler.options.lazy ||
            tag === 'SELECT' ||
            type === 'checkbox' || type === 'radio')
                ? 'change'
                : 'input'

        // determine the attribute to change when updating
        self.attr = type === 'checkbox'
            ? 'checked'
            : (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA')
                ? 'value'
                : 'innerHTML'

        // select[multiple] support
        if(tag === 'SELECT' && el.hasAttribute('multiple')) {
            this.multi = true
        }

        var compositionLock = false
        self.cLock = function () {
            compositionLock = true
        }
        self.cUnlock = function () {
            compositionLock = false
        }
        el.addEventListener('compositionstart', this.cLock)
        el.addEventListener('compositionend', this.cUnlock)

        // attach listener
        self.set = self.filters
            ? function () {
                if (compositionLock) return
                // if this directive has filters
                // we need to let the vm.$set trigger
                // update() so filters are applied.
                // therefore we have to record cursor position
                // so that after vm.$set changes the input
                // value we can put the cursor back at where it is
                var cursorPos
                try { cursorPos = el.selectionStart } catch (e) {}

                self._set()

                // since updates are async
                // we need to reset cursor position async too
                utils.nextTick(function () {
                    if (cursorPos !== undefined) {
                        el.setSelectionRange(cursorPos, cursorPos)
                    }
                })
            }
            : function () {
                if (compositionLock) return
                // no filters, don't let it trigger update()
                self.lock = true

                self._set()

                utils.nextTick(function () {
                    self.lock = false
                })
            }
        el.addEventListener(self.event, self.set)

        // fix shit for IE9
        // since it doesn't fire input on backspace / del / cut
        if (isIE9) {
            self.onCut = function () {
                // cut event fires before the value actually changes
                utils.nextTick(function () {
                    self.set()
                })
            }
            self.onDel = function (e) {
                if (e.keyCode === 46 || e.keyCode === 8) {
                    self.set()
                }
            }
            el.addEventListener('cut', self.onCut)
            el.addEventListener('keyup', self.onDel)
        }
    },

    _set: function () {
        this.ownerVM.$set(
            this.key, this.multi
                ? getMultipleSelectOptions(this.el)
                : this.el[this.attr]
        )
    },

    update: function (value, init) {
        /* jshint eqeqeq: false */
        // sync back inline value if initial data is undefined
        if (init && value === undefined) {
            return this._set()
        }
        if (this.lock) return
        var el = this.el
        if (el.tagName === 'SELECT') { // select dropdown
            el.selectedIndex = -1
            if(this.multi && Array.isArray(value)) {
                value.forEach(this.updateSelect, this)
            } else {
                this.updateSelect(value)
            }
        } else if (el.type === 'radio') { // radio button
            el.checked = value == el.value
        } else if (el.type === 'checkbox') { // checkbox
            el.checked = !!value
        } else {
            el[this.attr] = utils.guard(value)
        }
    },

    updateSelect: function (value) {
        /* jshint eqeqeq: false */
        // setting <select>'s value in IE9 doesn't work
        // we have to manually loop through the options
        var options = this.el.options,
            i = options.length
        while (i--) {
            if (options[i].value == value) {
                options[i].selected = true
                break
            }
        }
    },

    unbind: function () {
        var el = this.el
        el.removeEventListener(this.event, this.set)
        el.removeEventListener('compositionstart', this.cLock)
        el.removeEventListener('compositionend', this.cUnlock)
        if (isIE9) {
            el.removeEventListener('cut', this.onCut)
            el.removeEventListener('keyup', this.onDel)
        }
    }
}
},{"../utils":25}],12:[function(require,module,exports){
var utils    = require('../utils')

/**
 *  Binding for event listeners
 */
module.exports = {

    isFn: true,

    bind: function () {
        this.context = this.binding.isExp
            ? this.vm
            : this.binding.compiler.vm
    },

    update: function (handler) {
        if (typeof handler !== 'function') {
            utils.warn('Directive "v-on:' + this.expression + '" expects a method.')
            return
        }
        this._unbind()
        var vm = this.vm,
            context = this.context
        this.handler = function (e) {
            e.targetVM = vm
            context.$event = e
            var res = handler.call(context, e)
            context.$event = null
            return res
        }
        this.el.addEventListener(this.arg, this.handler)
    },

    unbind: function () {
        this.el.removeEventListener(this.arg, this.handler)
    }
}
},{"../utils":25}],13:[function(require,module,exports){
var utils = require('../utils')

/**
 *  Binding for partials
 */
module.exports = {

    isLiteral: true,

    bind: function () {

        var id = this.expression
        if (!id) return

        var el       = this.el,
            compiler = this.compiler,
            partial  = compiler.getOption('partials', id)

        if (!partial) {
            if (id === 'yield') {
                utils.warn('{{>yield}} syntax has been deprecated. Use <content> tag instead.')
            }
            return
        }

        partial = partial.cloneNode(true)

        // comment ref node means inline partial
        if (el.nodeType === 8) {

            // keep a ref for the partial's content nodes
            var nodes = [].slice.call(partial.childNodes),
                parent = el.parentNode
            parent.insertBefore(partial, el)
            parent.removeChild(el)
            // compile partial after appending, because its children's parentNode
            // will change from the fragment to the correct parentNode.
            // This could affect directives that need access to its element's parentNode.
            nodes.forEach(compiler.compile, compiler)

        } else {

            // just set innerHTML...
            el.innerHTML = ''
            el.appendChild(partial.cloneNode(true))

        }
    }

}
},{"../utils":25}],14:[function(require,module,exports){
var utils      = require('../utils'),
    config     = require('../config')

/**
 *  Binding that manages VMs based on an Array
 */
module.exports = {

    bind: function () {

        this.identifier = '$r' + this.id

        // a hash to cache the same expressions on repeated instances
        // so they don't have to be compiled for every single instance
        this.expCache = utils.hash()

        var el   = this.el,
            ctn  = this.container = el.parentNode

        // extract child Id, if any
        this.childId = this.compiler.eval(utils.attr(el, 'ref'))

        // create a comment node as a reference node for DOM insertions
        this.ref = document.createComment(config.prefix + '-repeat-' + this.key)
        ctn.insertBefore(this.ref, el)
        ctn.removeChild(el)

        this.collection = null
        this.vms = null

    },

    update: function (collection) {

        if (!Array.isArray(collection)) {
            if (utils.isObject(collection)) {
                collection = utils.objectToArray(collection)
            } else {
                utils.warn('v-repeat only accepts Array or Object values.')
            }
        }

        // keep reference of old data and VMs
        // so we can reuse them if possible
        this.oldVMs = this.vms
        this.oldCollection = this.collection
        collection = this.collection = collection || []

        var isObject = collection[0] && utils.isObject(collection[0])
        this.vms = this.oldCollection
            ? this.diff(collection, isObject)
            : this.init(collection, isObject)

        if (this.childId) {
            this.vm.$[this.childId] = this.vms
        }

    },

    init: function (collection, isObject) {
        var vm, vms = []
        for (var i = 0, l = collection.length; i < l; i++) {
            vm = this.build(collection[i], i, isObject)
            vms.push(vm)
            if (this.compiler.init) {
                this.container.insertBefore(vm.$el, this.ref)
            } else {
                vm.$before(this.ref)
            }
        }
        return vms
    },

    /**
     *  Diff the new array with the old
     *  and determine the minimum amount of DOM manipulations.
     */
    diff: function (newCollection, isObject) {

        var i, l, item, vm,
            oldIndex,
            targetNext,
            currentNext,
            nextEl,
            ctn    = this.container,
            oldVMs = this.oldVMs,
            vms    = []

        vms.length = newCollection.length

        // first pass, collect new reused and new created
        for (i = 0, l = newCollection.length; i < l; i++) {
            item = newCollection[i]
            if (isObject) {
                item.$index = i
                if (item.__emitter__ && item.__emitter__[this.identifier]) {
                    // this piece of data is being reused.
                    // record its final position in reused vms
                    item.$reused = true
                } else {
                    vms[i] = this.build(item, i, isObject)
                }
            } else {
                // we can't attach an identifier to primitive values
                // so have to do an indexOf...
                oldIndex = indexOf(oldVMs, item)
                if (oldIndex > -1) {
                    // record the position on the existing vm
                    oldVMs[oldIndex].$reused = true
                    oldVMs[oldIndex].$data.$index = i
                } else {
                    vms[i] = this.build(item, i, isObject)
                }
            }
        }

        // second pass, collect old reused and destroy unused
        for (i = 0, l = oldVMs.length; i < l; i++) {
            vm = oldVMs[i]
            item = this.arg
                ? vm.$data[this.arg]
                : vm.$data
            if (item.$reused) {
                vm.$reused = true
                delete item.$reused
            }
            if (vm.$reused) {
                // update the index to latest
                vm.$index = item.$index
                // the item could have had a new key
                if (item.$key && item.$key !== vm.$key) {
                    vm.$key = item.$key
                }
                vms[vm.$index] = vm
            } else {
                // this one can be destroyed.
                if (item.__emitter__) {
                    delete item.__emitter__[this.identifier]
                }
                vm.$destroy()
            }
        }

        // final pass, move/insert DOM elements
        i = vms.length
        while (i--) {
            vm = vms[i]
            item = vm.$data
            targetNext = vms[i + 1]
            if (vm.$reused) {
                nextEl = vm.$el.nextSibling
                // destroyed VMs' element might still be in the DOM
                // due to transitions
                while (!nextEl.vue_vm && nextEl !== this.ref) {
                    nextEl = nextEl.nextSibling
                }
                currentNext = nextEl.vue_vm
                if (currentNext !== targetNext) {
                    if (!targetNext) {
                        ctn.insertBefore(vm.$el, this.ref)
                    } else {
                        nextEl = targetNext.$el
                        // new VMs' element might not be in the DOM yet
                        // due to transitions
                        while (!nextEl.parentNode) {
                            targetNext = vms[nextEl.vue_vm.$index + 1]
                            nextEl = targetNext
                                ? targetNext.$el
                                : this.ref
                        }
                        ctn.insertBefore(vm.$el, nextEl)
                    }
                }
                delete vm.$reused
                delete item.$index
                delete item.$key
            } else { // a new vm
                vm.$before(targetNext ? targetNext.$el : this.ref)
            }
        }

        return vms
    },

    build: function (data, index, isObject) {

        // wrap non-object values
        var raw, alias,
            wrap = !isObject || this.arg
        if (wrap) {
            raw = data
            alias = this.arg || '$value'
            data = {}
            data[alias] = raw
        }
        data.$index = index

        var el = this.el.cloneNode(true),
            Ctor = this.compiler.resolveComponent(el, data),
            vm = new Ctor({
                el: el,
                data: data,
                parent: this.vm,
                compilerOptions: {
                    repeat: true,
                    expCache: this.expCache
                }
            })

        if (isObject) {
            // attach an ienumerable identifier to the raw data
            (raw || data).__emitter__[this.identifier] = true
        }

        if (wrap) {
            var self = this,
                sync = function (val) {
                    self.lock = true
                    self.collection.$set(vm.$index, val)
                    self.lock = false
                }
            vm.$compiler.observer.on('change:' + alias, sync)
        }

        return vm

    },

    unbind: function () {
        if (this.childId) {
            delete this.vm.$[this.childId]
        }
        if (this.vms) {
            var i = this.vms.length
            while (i--) {
                this.vms[i].$destroy()
            }
        }
    }
}

// Helpers --------------------------------------------------------------------

/**
 *  Find an object or a wrapped data object
 *  from an Array
 */
function indexOf (vms, obj) {
    for (var vm, i = 0, l = vms.length; i < l; i++) {
        vm = vms[i]
        if (!vm.$reused && vm.$value === obj) {
            return i
        }
    }
    return -1
}
},{"../config":5,"../utils":25}],15:[function(require,module,exports){
var camelRE = /-([a-z])/g,
    prefixes = ['webkit', 'moz', 'ms']

function camelReplacer (m) {
    return m[1].toUpperCase()
}

/**
 *  Binding for CSS styles
 */
module.exports = {

    bind: function () {
        var prop = this.arg
        if (!prop) return
        var first = prop.charAt(0)
        if (first === '$') {
            // properties that start with $ will be auto-prefixed
            prop = prop.slice(1)
            this.prefixed = true
        } else if (first === '-') {
            // normal starting hyphens should not be converted
            prop = prop.slice(1)
        }
        this.prop = prop.replace(camelRE, camelReplacer)
    },

    update: function (value) {
        var prop = this.prop
        if (prop) {
            this.el.style[prop] = value
            if (this.prefixed) {
                prop = prop.charAt(0).toUpperCase() + prop.slice(1)
                var i = prefixes.length
                while (i--) {
                    this.el.style[prefixes[i] + prop] = value
                }
            }
        } else {
            this.el.style.cssText = value
        }
    }

}
},{}],16:[function(require,module,exports){
/**
 *  Manages a conditional child VM using the
 *  binding's value as the component ID.
 */
module.exports = {

    bind: function () {

        // track position in DOM with a ref node
        var el       = this.raw = this.el,
            parent   = el.parentNode,
            ref      = this.ref = document.createComment('v-view')
        parent.insertBefore(ref, el)
        parent.removeChild(el)

        // cache original content
        /* jshint boss: true */
        var node,
            frag = this.inner = document.createElement('div')
        while (node = el.firstChild) {
            frag.appendChild(node)
        }

    },

    update: function(value) {

        this._unbind()

        var Ctor  = this.compiler.getOption('components', value)
        if (!Ctor) return

        this.childVM = new Ctor({
            el: this.raw.cloneNode(true),
            parent: this.vm,
            compilerOptions: {
                rawContent: this.inner.cloneNode(true)
            }
        })

        this.el = this.childVM.$el
        if (this.compiler.init) {
            this.ref.parentNode.insertBefore(this.el, this.ref)
        } else {
            this.childVM.$before(this.ref)
        }

    },

    unbind: function() {
        if (this.childVM) {
            this.childVM.$destroy()
        }
    }

}
},{}],17:[function(require,module,exports){
var utils = require('../utils')

/**
 *  Binding for inheriting data from parent VMs.
 */
module.exports = {

    bind: function () {

        var self      = this,
            childKey  = self.arg,
            parentKey = self.key,
            compiler  = self.compiler,
            owner     = self.binding.compiler

        if (compiler === owner) {
            this.alone = true
            return
        }

        if (childKey) {
            if (!compiler.bindings[childKey]) {
                compiler.createBinding(childKey)
            }
            // sync changes on child back to parent
            compiler.observer.on('change:' + childKey, function (val) {
                if (compiler.init) return
                if (!self.lock) {
                    self.lock = true
                    utils.nextTick(function () {
                        self.lock = false
                    })
                }
                owner.vm.$set(parentKey, val)
            })
        }
    },

    update: function (value) {
        // sync from parent
        if (!this.alone && !this.lock) {
            if (this.arg) {
                this.vm.$set(this.arg, value)
            } else {
                this.vm.$data = value
            }
        }
    }

}
},{"../utils":25}],18:[function(require,module,exports){
function Emitter (ctx) {
    this._ctx = ctx || this
}

var EmitterProto = Emitter.prototype

EmitterProto.on = function(event, fn){
    this._cbs = this._cbs || {}
    ;(this._cbs[event] = this._cbs[event] || [])
        .push(fn)
    return this
}

EmitterProto.once = function(event, fn){
    var self = this
    this._cbs = this._cbs || {}

    function on () {
        self.off(event, on)
        fn.apply(this, arguments)
    }

    on.fn = fn
    this.on(event, on)
    return this
}

EmitterProto.off = function(event, fn){
    this._cbs = this._cbs || {}

    // all
    if (!arguments.length) {
        this._cbs = {}
        return this
    }

    // specific event
    var callbacks = this._cbs[event]
    if (!callbacks) return this

    // remove all handlers
    if (arguments.length === 1) {
        delete this._cbs[event]
        return this
    }

    // remove specific handler
    var cb
    for (var i = 0; i < callbacks.length; i++) {
        cb = callbacks[i]
        if (cb === fn || cb.fn === fn) {
            callbacks.splice(i, 1)
            break
        }
    }
    return this
}

EmitterProto.emit = function(event, a, b, c){
    this._cbs = this._cbs || {}
    var callbacks = this._cbs[event]

    if (callbacks) {
        callbacks = callbacks.slice(0)
        for (var i = 0, len = callbacks.length; i < len; i++) {
            callbacks[i].call(this._ctx, a, b, c)
        }
    }

    return this
}

module.exports = Emitter
},{}],19:[function(require,module,exports){
var utils           = require('./utils'),
    STR_SAVE_RE     = /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g,
    STR_RESTORE_RE  = /"(\d+)"/g,
    NEWLINE_RE      = /\n/g,
    CTOR_RE         = new RegExp('constructor'.split('').join('[\'"+, ]*')),
    UNICODE_RE      = /\\u\d\d\d\d/

// Variable extraction scooped from https://github.com/RubyLouvre/avalon

var KEYWORDS =
        // keywords
        'break,case,catch,continue,debugger,default,delete,do,else,false' +
        ',finally,for,function,if,in,instanceof,new,null,return,switch,this' +
        ',throw,true,try,typeof,var,void,while,with,undefined' +
        // reserved
        ',abstract,boolean,byte,char,class,const,double,enum,export,extends' +
        ',final,float,goto,implements,import,int,interface,long,native' +
        ',package,private,protected,public,short,static,super,synchronized' +
        ',throws,transient,volatile' +
        // ECMA 5 - use strict
        ',arguments,let,yield' +
        // allow using Math in expressions
        ',Math',
        
    KEYWORDS_RE = new RegExp(["\\b" + KEYWORDS.replace(/,/g, '\\b|\\b') + "\\b"].join('|'), 'g'),
    REMOVE_RE   = /\/\*(?:.|\n)*?\*\/|\/\/[^\n]*\n|\/\/[^\n]*$|'[^']*'|"[^"]*"|[\s\t\n]*\.[\s\t\n]*[$\w\.]+/g,
    SPLIT_RE    = /[^\w$]+/g,
    NUMBER_RE   = /\b\d[^,]*/g,
    BOUNDARY_RE = /^,+|,+$/g

/**
 *  Strip top level variable names from a snippet of JS expression
 */
function getVariables (code) {
    code = code
        .replace(REMOVE_RE, '')
        .replace(SPLIT_RE, ',')
        .replace(KEYWORDS_RE, '')
        .replace(NUMBER_RE, '')
        .replace(BOUNDARY_RE, '')
    return code
        ? code.split(/,+/)
        : []
}

/**
 *  A given path could potentially exist not on the
 *  current compiler, but up in the parent chain somewhere.
 *  This function generates an access relationship string
 *  that can be used in the getter function by walking up
 *  the parent chain to check for key existence.
 *
 *  It stops at top parent if no vm in the chain has the
 *  key. It then creates any missing bindings on the
 *  final resolved vm.
 */
function traceScope (path, compiler, data) {
    var rel  = '',
        dist = 0,
        self = compiler

    if (data && utils.get(data, path) !== undefined) {
        // hack: temporarily attached data
        return '$temp.'
    }

    while (compiler) {
        if (compiler.hasKey(path)) {
            break
        } else {
            compiler = compiler.parent
            dist++
        }
    }
    if (compiler) {
        while (dist--) {
            rel += '$parent.'
        }
        if (!compiler.bindings[path] && path.charAt(0) !== '$') {
            compiler.createBinding(path)
        }
    } else {
        self.createBinding(path)
    }
    return rel
}

/**
 *  Create a function from a string...
 *  this looks like evil magic but since all variables are limited
 *  to the VM's data it's actually properly sandboxed
 */
function makeGetter (exp, raw) {
    var fn
    try {
        fn = new Function(exp)
    } catch (e) {
        utils.warn('Error parsing expression: ' + raw)
    }
    return fn
}

/**
 *  Escape a leading dollar sign for regex construction
 */
function escapeDollar (v) {
    return v.charAt(0) === '$'
        ? '\\' + v
        : v
}

/**
 *  Parse and return an anonymous computed property getter function
 *  from an arbitrary expression, together with a list of paths to be
 *  created as bindings.
 */
exports.parse = function (exp, compiler, data) {
    // unicode and 'constructor' are not allowed for XSS security.
    if (UNICODE_RE.test(exp) || CTOR_RE.test(exp)) {
        utils.warn('Unsafe expression: ' + exp)
        return
    }
    // extract variable names
    var vars = getVariables(exp)
    if (!vars.length) {
        return makeGetter('return ' + exp, exp)
    }
    vars = utils.unique(vars)

    var accessors = '',
        has       = utils.hash(),
        strings   = [],
        // construct a regex to extract all valid variable paths
        // ones that begin with "$" are particularly tricky
        // because we can't use \b for them
        pathRE = new RegExp(
            "[^$\\w\\.](" +
            vars.map(escapeDollar).join('|') +
            ")[$\\w\\.]*\\b", 'g'
        ),
        body = (' ' + exp)
            .replace(STR_SAVE_RE, saveStrings)
            .replace(pathRE, replacePath)
            .replace(STR_RESTORE_RE, restoreStrings)

    body = accessors + 'return ' + body

    function saveStrings (str) {
        var i = strings.length
        // escape newlines in strings so the expression
        // can be correctly evaluated
        strings[i] = str.replace(NEWLINE_RE, '\\n')
        return '"' + i + '"'
    }

    function replacePath (path) {
        // keep track of the first char
        var c = path.charAt(0)
        path = path.slice(1)
        var val = 'this.' + traceScope(path, compiler, data) + path
        if (!has[path]) {
            accessors += val + ';'
            has[path] = 1
        }
        // don't forget to put that first char back
        return c + val
    }

    function restoreStrings (str, i) {
        return strings[i]
    }

    return makeGetter(body, exp)
}

/**
 *  Evaluate an expression in the context of a compiler.
 *  Accepts additional data.
 */
exports.eval = function (exp, compiler, data) {
    var getter = exports.parse(exp, compiler, data), res
    if (getter) {
        // hack: temporarily attach the additional data so
        // it can be accessed in the getter
        compiler.vm.$temp = data
        res = getter.call(compiler.vm)
        delete compiler.vm.$temp
    }
    return res
}
},{"./utils":25}],20:[function(require,module,exports){
var utils    = require('./utils'),
    get      = utils.get,
    slice    = [].slice,
    QUOTE_RE = /^'.*'$/,
    filters  = module.exports = utils.hash()

/**
 *  'abc' => 'Abc'
 */
filters.capitalize = function (value) {
    if (!value && value !== 0) return ''
    value = value.toString()
    return value.charAt(0).toUpperCase() + value.slice(1)
}

/**
 *  'abc' => 'ABC'
 */
filters.uppercase = function (value) {
    return (value || value === 0)
        ? value.toString().toUpperCase()
        : ''
}

/**
 *  'AbC' => 'abc'
 */
filters.lowercase = function (value) {
    return (value || value === 0)
        ? value.toString().toLowerCase()
        : ''
}

/**
 *  12345 => $12,345.00
 */
filters.currency = function (value, sign) {
    if (!value && value !== 0) return ''
    sign = sign || '$'
    var s = Math.floor(value).toString(),
        i = s.length % 3,
        h = i > 0 ? (s.slice(0, i) + (s.length > 3 ? ',' : '')) : '',
        f = '.' + value.toFixed(2).slice(-2)
    return sign + h + s.slice(i).replace(/(\d{3})(?=\d)/g, '$1,') + f
}

/**
 *  args: an array of strings corresponding to
 *  the single, double, triple ... forms of the word to
 *  be pluralized. When the number to be pluralized
 *  exceeds the length of the args, it will use the last
 *  entry in the array.
 *
 *  e.g. ['single', 'double', 'triple', 'multiple']
 */
filters.pluralize = function (value) {
    var args = slice.call(arguments, 1)
    return args.length > 1
        ? (args[value - 1] || args[args.length - 1])
        : (args[value - 1] || args[0] + 's')
}

/**
 *  A special filter that takes a handler function,
 *  wraps it so it only gets triggered on specific keypresses.
 *
 *  v-on only
 */

var keyCodes = {
    enter    : 13,
    tab      : 9,
    'delete' : 46,
    up       : 38,
    left     : 37,
    right    : 39,
    down     : 40,
    esc      : 27
}

filters.key = function (handler, key) {
    if (!handler) return
    var code = keyCodes[key]
    if (!code) {
        code = parseInt(key, 10)
    }
    return function (e) {
        if (e.keyCode === code) {
            return handler.call(this, e)
        }
    }
}

/**
 *  Filter filter for v-repeat
 */
filters.filterBy = function (arr, searchKey, delimiter, dataKey) {

    // allow optional `in` delimiter
    // because why not
    if (delimiter && delimiter !== 'in') {
        dataKey = delimiter
    }

    // get the search string
    var search = stripQuotes(searchKey) || this.$get(searchKey)
    if (!search) return arr
    search = search.toLowerCase()

    // get the optional dataKey
    dataKey = dataKey && (stripQuotes(dataKey) || this.$get(dataKey))

    // convert object to array
    if (!Array.isArray(arr)) {
        arr = utils.objectToArray(arr)
    }

    return arr.filter(function (item) {
        return dataKey
            ? contains(get(item, dataKey), search)
            : contains(item, search)
    })

}

filters.filterBy.computed = true

/**
 *  Sort fitler for v-repeat
 */
filters.orderBy = function (arr, sortKey, reverseKey) {

    var key = stripQuotes(sortKey) || this.$get(sortKey)
    if (!key) return arr

    // convert object to array
    if (!Array.isArray(arr)) {
        arr = utils.objectToArray(arr)
    }

    var order = 1
    if (reverseKey) {
        if (reverseKey === '-1') {
            order = -1
        } else if (reverseKey.charAt(0) === '!') {
            reverseKey = reverseKey.slice(1)
            order = this.$get(reverseKey) ? 1 : -1
        } else {
            order = this.$get(reverseKey) ? -1 : 1
        }
    }

    // sort on a copy to avoid mutating original array
    return arr.slice().sort(function (a, b) {
        a = get(a, key)
        b = get(b, key)
        return a === b ? 0 : a > b ? order : -order
    })

}

filters.orderBy.computed = true

// Array filter helpers -------------------------------------------------------

/**
 *  String contain helper
 */
function contains (val, search) {
    /* jshint eqeqeq: false */
    if (utils.isObject(val)) {
        for (var key in val) {
            if (contains(val[key], search)) {
                return true
            }
        }
    } else if (val != null) {
        return val.toString().toLowerCase().indexOf(search) > -1
    }
}

/**
 *  Test whether a string is in quotes,
 *  if yes return stripped string
 */
function stripQuotes (str) {
    if (QUOTE_RE.test(str)) {
        return str.slice(1, -1)
    }
}
},{"./utils":25}],21:[function(require,module,exports){
var config      = require('./config'),
    ViewModel   = require('./viewmodel'),
    utils       = require('./utils'),
    makeHash    = utils.hash,
    assetTypes  = ['directive', 'filter', 'partial', 'effect', 'component']

// require these so Browserify can catch them
// so they can be used in Vue.require
require('./observer')
require('./transition')

ViewModel.options = config.globalAssets = {
    directives  : require('./directives'),
    filters     : require('./filters'),
    partials    : makeHash(),
    effects     : makeHash(),
    components  : makeHash()
}

/**
 *  Expose asset registration methods
 */
assetTypes.forEach(function (type) {
    ViewModel[type] = function (id, value) {
        var hash = this.options[type + 's']
        if (!hash) {
            hash = this.options[type + 's'] = makeHash()
        }
        if (!value) return hash[id]
        if (type === 'partial') {
            value = utils.toFragment(value)
        } else if (type === 'component') {
            value = utils.toConstructor(value)
        } else if (type === 'filter') {
            utils.checkFilter(value)
        }
        hash[id] = value
        return this
    }
})

/**
 *  Set config options
 */
ViewModel.config = function (opts, val) {
    if (typeof opts === 'string') {
        if (val === undefined) {
            return config[opts]
        } else {
            config[opts] = val
        }
    } else {
        utils.extend(config, opts)
    }
    return this
}

/**
 *  Expose an interface for plugins
 */
ViewModel.use = function (plugin) {
    if (typeof plugin === 'string') {
        try {
            plugin = require(plugin)
        } catch (e) {
            utils.warn('Cannot find plugin: ' + plugin)
            return
        }
    }

    // additional parameters
    var args = [].slice.call(arguments, 1)
    args.unshift(this)

    if (typeof plugin.install === 'function') {
        plugin.install.apply(plugin, args)
    } else {
        plugin.apply(null, args)
    }
    return this
}

/**
 *  Expose internal modules for plugins
 */
ViewModel.require = function (path) {
    return require('./' + path)
}

ViewModel.extend = extend
ViewModel.nextTick = utils.nextTick

/**
 *  Expose the main ViewModel class
 *  and add extend method
 */
function extend (options) {

    var ParentVM = this

    // extend data options need to be copied
    // on instantiation
    if (options.data) {
        options.defaultData = options.data
        delete options.data
    }

    // inherit options
    options = inheritOptions(options, ParentVM.options, true)
    utils.processOptions(options)

    var ExtendedVM = function (opts, asParent) {
        if (!asParent) {
            opts = inheritOptions(opts, options, true)
        }
        ParentVM.call(this, opts, true)
    }

    // inherit prototype props
    var proto = ExtendedVM.prototype = Object.create(ParentVM.prototype)
    utils.defProtected(proto, 'constructor', ExtendedVM)

    // allow extended VM to be further extended
    ExtendedVM.extend  = extend
    ExtendedVM.super   = ParentVM
    ExtendedVM.options = options

    // allow extended VM to add its own assets
    assetTypes.forEach(function (type) {
        ExtendedVM[type] = ViewModel[type]
    })

    // allow extended VM to use plugins
    ExtendedVM.use     = ViewModel.use
    ExtendedVM.require = ViewModel.require

    return ExtendedVM
}

/**
 *  Inherit options
 *
 *  For options such as `data`, `vms`, `directives`, 'partials',
 *  they should be further extended. However extending should only
 *  be done at top level.
 *  
 *  `proto` is an exception because it's handled directly on the
 *  prototype.
 *
 *  `el` is an exception because it's not allowed as an
 *  extension option, but only as an instance option.
 */
function inheritOptions (child, parent, topLevel) {
    child = child || {}
    if (!parent) return child
    for (var key in parent) {
        if (key === 'el') continue
        var val = child[key],
            parentVal = parent[key]
        if (topLevel && typeof val === 'function' && parentVal) {
            // merge hook functions into an array
            child[key] = [val]
            if (Array.isArray(parentVal)) {
                child[key] = child[key].concat(parentVal)
            } else {
                child[key].push(parentVal)
            }
        } else if (
            topLevel &&
            (utils.isTrueObject(val) || utils.isTrueObject(parentVal))
            && !(parentVal instanceof ViewModel)
        ) {
            // merge toplevel object options
            child[key] = inheritOptions(val, parentVal)
        } else if (val === undefined) {
            // inherit if child doesn't override
            child[key] = parentVal
        }
    }
    return child
}

module.exports = ViewModel
},{"./config":5,"./directives":10,"./filters":20,"./observer":22,"./transition":24,"./utils":25,"./viewmodel":26}],22:[function(require,module,exports){
/* jshint proto:true */

var Emitter  = require('./emitter'),
    utils    = require('./utils'),
    // cache methods
    def      = utils.defProtected,
    isObject = utils.isObject,
    isArray  = Array.isArray,
    hasOwn   = ({}).hasOwnProperty,
    oDef     = Object.defineProperty,
    slice    = [].slice,
    // fix for IE + __proto__ problem
    // define methods as inenumerable if __proto__ is present,
    // otherwise enumerable so we can loop through and manually
    // attach to array instances
    hasProto = ({}).__proto__

// Array Mutation Handlers & Augmentations ------------------------------------

// The proxy prototype to replace the __proto__ of
// an observed array
var ArrayProxy = Object.create(Array.prototype)

// intercept mutation methods
;[
    'push',
    'pop',
    'shift',
    'unshift',
    'splice',
    'sort',
    'reverse'
].forEach(watchMutation)

// Augment the ArrayProxy with convenience methods
def(ArrayProxy, '$set', function (index, data) {
    return this.splice(index, 1, data)[0]
}, !hasProto)

def(ArrayProxy, '$remove', function (index) {
    if (typeof index !== 'number') {
        index = this.indexOf(index)
    }
    if (index > -1) {
        return this.splice(index, 1)[0]
    }
}, !hasProto)

/**
 *  Intercep a mutation event so we can emit the mutation info.
 *  we also analyze what elements are added/removed and link/unlink
 *  them with the parent Array.
 */
function watchMutation (method) {
    def(ArrayProxy, method, function () {

        var args = slice.call(arguments),
            result = Array.prototype[method].apply(this, args),
            inserted, removed

        // determine new / removed elements
        if (method === 'push' || method === 'unshift') {
            inserted = args
        } else if (method === 'pop' || method === 'shift') {
            removed = [result]
        } else if (method === 'splice') {
            inserted = args.slice(2)
            removed = result
        }
        
        // link & unlink
        linkArrayElements(this, inserted)
        unlinkArrayElements(this, removed)

        // emit the mutation event
        this.__emitter__.emit('mutate', '', this, {
            method   : method,
            args     : args,
            result   : result,
            inserted : inserted,
            removed  : removed
        })

        return result
        
    }, !hasProto)
}

/**
 *  Link new elements to an Array, so when they change
 *  and emit events, the owner Array can be notified.
 */
function linkArrayElements (arr, items) {
    if (items) {
        var i = items.length, item, owners
        while (i--) {
            item = items[i]
            if (isWatchable(item)) {
                // if object is not converted for observing
                // convert it...
                if (!item.__emitter__) {
                    convert(item)
                    watch(item)
                }
                owners = item.__emitter__.owners
                if (owners.indexOf(arr) < 0) {
                    owners.push(arr)
                }
            }
        }
    }
}

/**
 *  Unlink removed elements from the ex-owner Array.
 */
function unlinkArrayElements (arr, items) {
    if (items) {
        var i = items.length, item
        while (i--) {
            item = items[i]
            if (item && item.__emitter__) {
                var owners = item.__emitter__.owners
                if (owners) owners.splice(owners.indexOf(arr))
            }
        }
    }
}

// Object add/delete key augmentation -----------------------------------------

var ObjProxy = Object.create(Object.prototype)

def(ObjProxy, '$add', function (key, val) {
    if (hasOwn.call(this, key)) return
    this[key] = val
    convertKey(this, key)
    // emit a propagating set event
    this.__emitter__.emit('set', key, val, true)
}, !hasProto)

def(ObjProxy, '$delete', function (key) {
    if (!(hasOwn.call(this, key))) return
    // trigger set events
    this[key] = undefined
    delete this[key]
    this.__emitter__.emit('delete', key)
}, !hasProto)

// Watch Helpers --------------------------------------------------------------

/**
 *  Check if a value is watchable
 */
function isWatchable (obj) {
    return typeof obj === 'object' && obj && !obj.$compiler
}

/**
 *  Convert an Object/Array to give it a change emitter.
 */
function convert (obj) {
    if (obj.__emitter__) return true
    var emitter = new Emitter()
    def(obj, '__emitter__', emitter)
    emitter
        .on('set', function (key, val, propagate) {
            if (propagate) propagateChange(obj)
        })
        .on('mutate', function () {
            propagateChange(obj)
        })
    emitter.values = utils.hash()
    emitter.owners = []
    return false
}

/**
 *  Propagate an array element's change to its owner arrays
 */
function propagateChange (obj) {
    var owners = obj.__emitter__.owners,
        i = owners.length
    while (i--) {
        owners[i].__emitter__.emit('set', '', '', true)
    }
}

/**
 *  Watch target based on its type
 */
function watch (obj) {
    if (isArray(obj)) {
        watchArray(obj)
    } else {
        watchObject(obj)
    }
}

/**
 *  Augment target objects with modified
 *  methods
 */
function augment (target, src) {
    if (hasProto) {
        target.__proto__ = src
    } else {
        for (var key in src) {
            def(target, key, src[key])
        }
    }
}

/**
 *  Watch an Object, recursive.
 */
function watchObject (obj) {
    augment(obj, ObjProxy)
    for (var key in obj) {
        convertKey(obj, key)
    }
}

/**
 *  Watch an Array, overload mutation methods
 *  and add augmentations by intercepting the prototype chain
 */
function watchArray (arr) {
    augment(arr, ArrayProxy)
    linkArrayElements(arr, arr)
}

/**
 *  Define accessors for a property on an Object
 *  so it emits get/set events.
 *  Then watch the value itself.
 */
function convertKey (obj, key) {
    var keyPrefix = key.charAt(0)
    if (keyPrefix === '$' || keyPrefix === '_') {
        return
    }
    // emit set on bind
    // this means when an object is observed it will emit
    // a first batch of set events.
    var emitter = obj.__emitter__,
        values  = emitter.values

    init(obj[key])

    oDef(obj, key, {
        enumerable: true,
        configurable: true,
        get: function () {
            var value = values[key]
            // only emit get on tip values
            if (pub.shouldGet) {
                emitter.emit('get', key)
            }
            return value
        },
        set: function (newVal) {
            var oldVal = values[key]
            unobserve(oldVal, key, emitter)
            copyPaths(newVal, oldVal)
            // an immediate property should notify its parent
            // to emit set for itself too
            init(newVal, true)
        }
    })

    function init (val, propagate) {
        values[key] = val
        emitter.emit('set', key, val, propagate)
        if (isArray(val)) {
            emitter.emit('set', key + '.length', val.length, propagate)
        }
        observe(val, key, emitter)
    }
}

/**
 *  When a value that is already converted is
 *  observed again by another observer, we can skip
 *  the watch conversion and simply emit set event for
 *  all of its properties.
 */
function emitSet (obj) {
    var emitter = obj && obj.__emitter__
    if (!emitter) return
    if (isArray(obj)) {
        emitter.emit('set', 'length', obj.length)
    } else {
        var key, val
        for (key in obj) {
            val = obj[key]
            emitter.emit('set', key, val)
            emitSet(val)
        }
    }
}

/**
 *  Make sure all the paths in an old object exists
 *  in a new object.
 *  So when an object changes, all missing keys will
 *  emit a set event with undefined value.
 */
function copyPaths (newObj, oldObj) {
    if (!isObject(newObj) || !isObject(oldObj)) {
        return
    }
    var path, oldVal, newVal
    for (path in oldObj) {
        if (!(hasOwn.call(newObj, path))) {
            oldVal = oldObj[path]
            if (isArray(oldVal)) {
                newObj[path] = []
            } else if (isObject(oldVal)) {
                newVal = newObj[path] = {}
                copyPaths(newVal, oldVal)
            } else {
                newObj[path] = undefined
            }
        }
    }
}

/**
 *  walk along a path and make sure it can be accessed
 *  and enumerated in that object
 */
function ensurePath (obj, key) {
    var path = key.split('.'), sec
    for (var i = 0, d = path.length - 1; i < d; i++) {
        sec = path[i]
        if (!obj[sec]) {
            obj[sec] = {}
            if (obj.__emitter__) convertKey(obj, sec)
        }
        obj = obj[sec]
    }
    if (isObject(obj)) {
        sec = path[i]
        if (!(hasOwn.call(obj, sec))) {
            obj[sec] = undefined
            if (obj.__emitter__) convertKey(obj, sec)
        }
    }
}

// Main API Methods -----------------------------------------------------------

/**
 *  Observe an object with a given path,
 *  and proxy get/set/mutate events to the provided observer.
 */
function observe (obj, rawPath, observer) {

    if (!isWatchable(obj)) return

    var path = rawPath ? rawPath + '.' : '',
        alreadyConverted = convert(obj),
        emitter = obj.__emitter__

    // setup proxy listeners on the parent observer.
    // we need to keep reference to them so that they
    // can be removed when the object is un-observed.
    observer.proxies = observer.proxies || {}
    var proxies = observer.proxies[path] = {
        get: function (key) {
            observer.emit('get', path + key)
        },
        set: function (key, val, propagate) {
            if (key) observer.emit('set', path + key, val)
            // also notify observer that the object itself changed
            // but only do so when it's a immediate property. this
            // avoids duplicate event firing.
            if (rawPath && propagate) {
                observer.emit('set', rawPath, obj, true)
            }
        },
        mutate: function (key, val, mutation) {
            // if the Array is a root value
            // the key will be null
            var fixedPath = key ? path + key : rawPath
            observer.emit('mutate', fixedPath, val, mutation)
            // also emit set for Array's length when it mutates
            var m = mutation.method
            if (m !== 'sort' && m !== 'reverse') {
                observer.emit('set', fixedPath + '.length', val.length)
            }
        }
    }

    // attach the listeners to the child observer.
    // now all the events will propagate upwards.
    emitter
        .on('get', proxies.get)
        .on('set', proxies.set)
        .on('mutate', proxies.mutate)

    if (alreadyConverted) {
        // for objects that have already been converted,
        // emit set events for everything inside
        emitSet(obj)
    } else {
        watch(obj)
    }
}

/**
 *  Cancel observation, turn off the listeners.
 */
function unobserve (obj, path, observer) {

    if (!obj || !obj.__emitter__) return

    path = path ? path + '.' : ''
    var proxies = observer.proxies[path]
    if (!proxies) return

    // turn off listeners
    obj.__emitter__
        .off('get', proxies.get)
        .off('set', proxies.set)
        .off('mutate', proxies.mutate)

    // remove reference
    observer.proxies[path] = null
}

// Expose API -----------------------------------------------------------------

var pub = module.exports = {

    // whether to emit get events
    // only enabled during dependency parsing
    shouldGet   : false,

    observe     : observe,
    unobserve   : unobserve,
    ensurePath  : ensurePath,
    copyPaths   : copyPaths,
    watch       : watch,
    convert     : convert,
    convertKey  : convertKey
}
},{"./emitter":18,"./utils":25}],23:[function(require,module,exports){
var openChar        = '{',
    endChar         = '}',
    ESCAPE_RE       = /[-.*+?^${}()|[\]\/\\]/g,
    BINDING_RE      = buildInterpolationRegex(),
    // lazy require
    Directive

function buildInterpolationRegex () {
    var open = escapeRegex(openChar),
        end  = escapeRegex(endChar)
    return new RegExp(open + open + open + '?(.+?)' + end + '?' + end + end)
}

function escapeRegex (str) {
    return str.replace(ESCAPE_RE, '\\$&')
}

function setDelimiters (delimiters) {
    exports.delimiters = delimiters
    openChar = delimiters[0]
    endChar = delimiters[1]
    BINDING_RE = buildInterpolationRegex()
}

/** 
 *  Parse a piece of text, return an array of tokens
 *  token types:
 *  1. plain string
 *  2. object with key = binding key
 *  3. object with key & html = true
 */
function parse (text) {
    if (!BINDING_RE.test(text)) return null
    var m, i, token, match, tokens = []
    /* jshint boss: true */
    while (m = text.match(BINDING_RE)) {
        i = m.index
        if (i > 0) tokens.push(text.slice(0, i))
        token = { key: m[1].trim() }
        match = m[0]
        token.html =
            match.charAt(2) === openChar &&
            match.charAt(match.length - 3) === endChar
        tokens.push(token)
        text = text.slice(i + m[0].length)
    }
    if (text.length) tokens.push(text)
    return tokens
}

/**
 *  Parse an attribute value with possible interpolation tags
 *  return a Directive-friendly expression
 *
 *  e.g.  a {{b}} c  =>  "a " + b + " c"
 */
function parseAttr (attr) {
    Directive = Directive || require('./directive')
    var tokens = parse(attr)
    if (!tokens) return null
    if (tokens.length === 1) return tokens[0].key
    var res = [], token
    for (var i = 0, l = tokens.length; i < l; i++) {
        token = tokens[i]
        res.push(
            token.key
                ? inlineFilters(token.key)
                : ('"' + token + '"')
        )
    }
    return res.join('+')
}

/**
 *  Inlines any possible filters in a binding
 *  so that we can combine everything into a huge expression
 */
function inlineFilters (key) {
    if (key.indexOf('|') > -1) {
        var dirs = Directive.parse(key),
            dir = dirs && dirs[0]
        if (dir && dir.filters) {
            key = Directive.inlineFilters(
                dir.key,
                dir.filters
            )
        }
    }
    return '(' + key + ')'
}

exports.parse         = parse
exports.parseAttr     = parseAttr
exports.setDelimiters = setDelimiters
exports.delimiters    = [openChar, endChar]
},{"./directive":7}],24:[function(require,module,exports){
var endEvents  = sniffEndEvents(),
    config     = require('./config'),
    // batch enter animations so we only force the layout once
    Batcher    = require('./batcher'),
    batcher    = new Batcher(),
    // cache timer functions
    setTO      = window.setTimeout,
    clearTO    = window.clearTimeout,
    // exit codes for testing
    codes = {
        CSS_E     : 1,
        CSS_L     : 2,
        JS_E      : 3,
        JS_L      : 4,
        CSS_SKIP  : -1,
        JS_SKIP   : -2,
        JS_SKIP_E : -3,
        JS_SKIP_L : -4,
        INIT      : -5,
        SKIP      : -6
    }

// force layout before triggering transitions/animations
batcher._preFlush = function () {
    /* jshint unused: false */
    var f = document.body.offsetHeight
}

/**
 *  stage:
 *    1 = enter
 *    2 = leave
 */
var transition = module.exports = function (el, stage, cb, compiler) {

    var changeState = function () {
        cb()
        compiler.execHook(stage > 0 ? 'attached' : 'detached')
    }

    if (compiler.init) {
        changeState()
        return codes.INIT
    }

    var hasTransition = el.vue_trans === '',
        hasAnimation  = el.vue_anim === '',
        effectId      = el.vue_effect

    if (effectId) {
        return applyTransitionFunctions(
            el,
            stage,
            changeState,
            effectId,
            compiler
        )
    } else if (hasTransition || hasAnimation) {
        return applyTransitionClass(
            el,
            stage,
            changeState,
            hasAnimation
        )
    } else {
        changeState()
        return codes.SKIP
    }

}

transition.codes = codes

/**
 *  Togggle a CSS class to trigger transition
 */
function applyTransitionClass (el, stage, changeState, hasAnimation) {

    if (!endEvents.trans) {
        changeState()
        return codes.CSS_SKIP
    }

    // if the browser supports transition,
    // it must have classList...
    var onEnd,
        classList        = el.classList,
        existingCallback = el.vue_trans_cb,
        enterClass       = config.enterClass,
        leaveClass       = config.leaveClass,
        endEvent         = hasAnimation ? endEvents.anim : endEvents.trans

    // cancel unfinished callbacks and jobs
    if (existingCallback) {
        el.removeEventListener(endEvent, existingCallback)
        classList.remove(enterClass)
        classList.remove(leaveClass)
        el.vue_trans_cb = null
    }

    if (stage > 0) { // enter

        // set to enter state before appending
        classList.add(enterClass)
        // append
        changeState()
        // trigger transition
        if (!hasAnimation) {
            batcher.push({
                execute: function () {
                    classList.remove(enterClass)
                }
            })
        } else {
            onEnd = function (e) {
                if (e.target === el) {
                    el.removeEventListener(endEvent, onEnd)
                    el.vue_trans_cb = null
                    classList.remove(enterClass)
                }
            }
            el.addEventListener(endEvent, onEnd)
            el.vue_trans_cb = onEnd
        }
        return codes.CSS_E

    } else { // leave

        if (el.offsetWidth || el.offsetHeight) {
            // trigger hide transition
            classList.add(leaveClass)
            onEnd = function (e) {
                if (e.target === el) {
                    el.removeEventListener(endEvent, onEnd)
                    el.vue_trans_cb = null
                    // actually remove node here
                    changeState()
                    classList.remove(leaveClass)
                }
            }
            // attach transition end listener
            el.addEventListener(endEvent, onEnd)
            el.vue_trans_cb = onEnd
        } else {
            // directly remove invisible elements
            changeState()
        }
        return codes.CSS_L
        
    }

}

function applyTransitionFunctions (el, stage, changeState, effectId, compiler) {

    var funcs = compiler.getOption('effects', effectId)
    if (!funcs) {
        changeState()
        return codes.JS_SKIP
    }

    var enter = funcs.enter,
        leave = funcs.leave,
        timeouts = el.vue_timeouts

    // clear previous timeouts
    if (timeouts) {
        var i = timeouts.length
        while (i--) {
            clearTO(timeouts[i])
        }
    }

    timeouts = el.vue_timeouts = []
    function timeout (cb, delay) {
        var id = setTO(function () {
            cb()
            timeouts.splice(timeouts.indexOf(id), 1)
            if (!timeouts.length) {
                el.vue_timeouts = null
            }
        }, delay)
        timeouts.push(id)
    }

    if (stage > 0) { // enter
        if (typeof enter !== 'function') {
            changeState()
            return codes.JS_SKIP_E
        }
        enter(el, changeState, timeout)
        return codes.JS_E
    } else { // leave
        if (typeof leave !== 'function') {
            changeState()
            return codes.JS_SKIP_L
        }
        leave(el, changeState, timeout)
        return codes.JS_L
    }

}

/**
 *  Sniff proper transition end event name
 */
function sniffEndEvents () {
    var el = document.createElement('vue'),
        defaultEvent = 'transitionend',
        events = {
            'transition'       : defaultEvent,
            'mozTransition'    : defaultEvent,
            'webkitTransition' : 'webkitTransitionEnd'
        },
        ret = {}
    for (var name in events) {
        if (el.style[name] !== undefined) {
            ret.trans = events[name]
            break
        }
    }
    ret.anim = el.style.animation === ''
        ? 'animationend'
        : 'webkitAnimationEnd'
    return ret
}
},{"./batcher":2,"./config":5}],25:[function(require,module,exports){
var config    = require('./config'),
    toString  = ({}).toString,
    win       = window,
    console   = win.console,
    timeout   = win.setTimeout,
    def       = Object.defineProperty,
    THIS_RE   = /[^\w]this[^\w]/,
    OBJECT    = 'object',
    hasClassList = 'classList' in document.documentElement,
    ViewModel // late def

var utils = module.exports = {

    /**
     *  get a value from an object keypath
     */
    get: function (obj, key) {
        /* jshint eqeqeq: false */
        if (key.indexOf('.') < 0) {
            return obj[key]
        }
        var path = key.split('.'),
            d = -1, l = path.length
        while (++d < l && obj != null) {
            obj = obj[path[d]]
        }
        return obj
    },

    /**
     *  set a value to an object keypath
     */
    set: function (obj, key, val) {
        /* jshint eqeqeq: false */
        if (key.indexOf('.') < 0) {
            obj[key] = val
            return
        }
        var path = key.split('.'),
            d = -1, l = path.length - 1
        while (++d < l) {
            if (obj[path[d]] == null) {
                obj[path[d]] = {}
            }
            obj = obj[path[d]]
        }
        obj[path[d]] = val
    },

    /**
     *  return the base segment of a keypath
     */
    baseKey: function (key) {
        return key.indexOf('.') > 0
            ? key.split('.')[0]
            : key
    },

    /**
     *  Create a prototype-less object
     *  which is a better hash/map
     */
    hash: function () {
        return Object.create(null)
    },

    /**
     *  get an attribute and remove it.
     */
    attr: function (el, type) {
        var attr = config.prefix + '-' + type,
            val = el.getAttribute(attr)
        if (val !== null) {
            el.removeAttribute(attr)
        }
        return val
    },

    /**
     *  Define an ienumerable property
     *  This avoids it being included in JSON.stringify
     *  or for...in loops.
     */
    defProtected: function (obj, key, val, enumerable, writable) {
        def(obj, key, {
            value        : val,
            enumerable   : enumerable,
            writable     : writable,
            configurable : true
        })
    },

    /**
     *  A less bullet-proof but more efficient type check
     *  than Object.prototype.toString
     */
    isObject: function (obj) {
        return typeof obj === OBJECT && obj && !Array.isArray(obj)
    },

    /**
     *  A more accurate but less efficient type check
     */
    isTrueObject: function (obj) {
        return toString.call(obj) === '[object Object]'
    },

    /**
     *  Most simple bind
     *  enough for the usecase and fast than native bind()
     */
    bind: function (fn, ctx) {
        return function (arg) {
            return fn.call(ctx, arg)
        }
    },

    /**
     *  Make sure null and undefined output empty string
     */
    guard: function (value) {
        /* jshint eqeqeq: false, eqnull: true */
        return value == null
            ? ''
            : (typeof value == 'object')
                ? JSON.stringify(value)
                : value
    },

    /**
     *  When setting value on the VM, parse possible numbers
     */
    checkNumber: function (value) {
        return (isNaN(value) || value === null || typeof value === 'boolean')
            ? value
            : Number(value)
    },

    /**
     *  simple extend
     */
    extend: function (obj, ext) {
        for (var key in ext) {
            if (obj[key] !== ext[key]) {
                obj[key] = ext[key]
            }
        }
        return obj
    },

    /**
     *  filter an array with duplicates into uniques
     */
    unique: function (arr) {
        var hash = utils.hash(),
            i = arr.length,
            key, res = []
        while (i--) {
            key = arr[i]
            if (hash[key]) continue
            hash[key] = 1
            res.push(key)
        }
        return res
    },

    /**
     *  Convert a string template to a dom fragment
     */
    toFragment: function (template) {
        if (typeof template !== 'string') {
            return template
        }
        if (template.charAt(0) === '#') {
            var templateNode = document.getElementById(template.slice(1))
            if (!templateNode) return
            // if its a template tag and the browser supports it,
            // its content is already a document fragment!
            if (templateNode.tagName === 'TEMPLATE' && templateNode.content) {
                return templateNode.content
            }
            template = templateNode.innerHTML
        }
        var node = document.createElement('div'),
            frag = document.createDocumentFragment(),
            child
        node.innerHTML = template.trim()
        /* jshint boss: true */
        while (child = node.firstChild) {
            if (node.nodeType === 1) {
                frag.appendChild(child)
            }
        }
        return frag
    },

    /**
     *  Convert the object to a ViewModel constructor
     *  if it is not already one
     */
    toConstructor: function (obj) {
        ViewModel = ViewModel || require('./viewmodel')
        return utils.isObject(obj)
            ? ViewModel.extend(obj)
            : typeof obj === 'function'
                ? obj
                : null
    },

    /**
     *  Check if a filter function contains references to `this`
     *  If yes, mark it as a computed filter.
     */
    checkFilter: function (filter) {
        if (THIS_RE.test(filter.toString())) {
            filter.computed = true
        }
    },

    /**
     *  convert certain option values to the desired format.
     */
    processOptions: function (options) {
        var components = options.components,
            partials   = options.partials,
            template   = options.template,
            filters    = options.filters,
            key
        if (components) {
            for (key in components) {
                components[key] = utils.toConstructor(components[key])
            }
        }
        if (partials) {
            for (key in partials) {
                partials[key] = utils.toFragment(partials[key])
            }
        }
        if (filters) {
            for (key in filters) {
                utils.checkFilter(filters[key])
            }
        }
        if (template) {
            options.template = utils.toFragment(template)
        }
    },

    /**
     *  used to defer batch updates
     */
    nextTick: function (cb) {
        timeout(cb, 0)
    },

    /**
     *  add class for IE9
     *  uses classList if available
     */
    addClass: function (el, cls) {
        if (hasClassList) {
            el.classList.add(cls)
        } else {
            var cur = ' ' + el.className + ' '
            if (cur.indexOf(' ' + cls + ' ') < 0) {
                el.className = (cur + cls).trim()
            }
        }
    },

    /**
     *  remove class for IE9
     */
    removeClass: function (el, cls) {
        if (hasClassList) {
            el.classList.remove(cls)
        } else {
            var cur = ' ' + el.className + ' ',
                tar = ' ' + cls + ' '
            while (cur.indexOf(tar) >= 0) {
                cur = cur.replace(tar, ' ')
            }
            el.className = cur.trim()
        }
    },

    /**
     *  Convert an object to Array
     *  used in v-repeat and array filters
     */
    objectToArray: function (obj) {
        var res = [], val, data
        for (var key in obj) {
            val = obj[key]
            data = utils.isObject(val)
                ? val
                : { $value: val }
            data.$key = key
            res.push(data)
        }
        return res
    }
}

enableDebug()
function enableDebug () {
    /**
     *  log for debugging
     */
    utils.log = function (msg) {
        if (config.debug && console) {
            console.log(msg)
        }
    }
    
    /**
     *  warnings, traces by default
     *  can be suppressed by `silent` option.
     */
    utils.warn = function (msg) {
        if (!config.silent && console) {
            console.warn(msg)
            if (config.debug && console.trace) {
                console.trace()
            }
        }
    }
}
},{"./config":5,"./viewmodel":26}],26:[function(require,module,exports){
var Compiler   = require('./compiler'),
    utils      = require('./utils'),
    transition = require('./transition'),
    Batcher    = require('./batcher'),
    slice      = [].slice,
    def        = utils.defProtected,
    nextTick   = utils.nextTick,

    // batch $watch callbacks
    watcherBatcher = new Batcher(),
    watcherId      = 1

/**
 *  ViewModel exposed to the user that holds data,
 *  computed properties, event handlers
 *  and a few reserved methods
 */
function ViewModel (options) {
    // just compile. options are passed directly to compiler
    new Compiler(this, options)
}

// All VM prototype methods are inenumerable
// so it can be stringified/looped through as raw data
var VMProto = ViewModel.prototype

/**
 *  Convenience function to get a value from
 *  a keypath
 */
def(VMProto, '$get', function (key) {
    var val = utils.get(this, key)
    return val === undefined && this.$parent
        ? this.$parent.$get(key)
        : val
})

/**
 *  Convenience function to set an actual nested value
 *  from a flat key string. Used in directives.
 */
def(VMProto, '$set', function (key, value) {
    utils.set(this, key, value)
})

/**
 *  watch a key on the viewmodel for changes
 *  fire callback with new value
 */
def(VMProto, '$watch', function (key, callback) {
    // save a unique id for each watcher
    var id = watcherId++,
        self = this
    function on () {
        var args = slice.call(arguments)
        watcherBatcher.push({
            id: id,
            override: true,
            execute: function () {
                callback.apply(self, args)
            }
        })
    }
    callback._fn = on
    self.$compiler.observer.on('change:' + key, on)
})

/**
 *  unwatch a key
 */
def(VMProto, '$unwatch', function (key, callback) {
    // workaround here
    // since the emitter module checks callback existence
    // by checking the length of arguments
    var args = ['change:' + key],
        ob = this.$compiler.observer
    if (callback) args.push(callback._fn)
    ob.off.apply(ob, args)
})

/**
 *  unbind everything, remove everything
 */
def(VMProto, '$destroy', function () {
    this.$compiler.destroy()
})

/**
 *  broadcast an event to all child VMs recursively.
 */
def(VMProto, '$broadcast', function () {
    var children = this.$compiler.children,
        i = children.length,
        child
    while (i--) {
        child = children[i]
        child.emitter.emit.apply(child.emitter, arguments)
        child.vm.$broadcast.apply(child.vm, arguments)
    }
})

/**
 *  emit an event that propagates all the way up to parent VMs.
 */
def(VMProto, '$dispatch', function () {
    var compiler = this.$compiler,
        emitter = compiler.emitter,
        parent = compiler.parent
    emitter.emit.apply(emitter, arguments)
    if (parent) {
        parent.vm.$dispatch.apply(parent.vm, arguments)
    }
})

/**
 *  delegate on/off/once to the compiler's emitter
 */
;['emit', 'on', 'off', 'once'].forEach(function (method) {
    def(VMProto, '$' + method, function () {
        var emitter = this.$compiler.emitter
        emitter[method].apply(emitter, arguments)
    })
})

// DOM convenience methods

def(VMProto, '$appendTo', function (target, cb) {
    target = query(target)
    var el = this.$el
    transition(el, 1, function () {
        target.appendChild(el)
        if (cb) nextTick(cb)
    }, this.$compiler)
})

def(VMProto, '$remove', function (cb) {
    var el = this.$el
    transition(el, -1, function () {
        if (el.parentNode) {
            el.parentNode.removeChild(el)
        }
        if (cb) nextTick(cb)
    }, this.$compiler)
})

def(VMProto, '$before', function (target, cb) {
    target = query(target)
    var el = this.$el
    transition(el, 1, function () {
        target.parentNode.insertBefore(el, target)
        if (cb) nextTick(cb)
    }, this.$compiler)
})

def(VMProto, '$after', function (target, cb) {
    target = query(target)
    var el = this.$el
    transition(el, 1, function () {
        if (target.nextSibling) {
            target.parentNode.insertBefore(el, target.nextSibling)
        } else {
            target.parentNode.appendChild(el)
        }
        if (cb) nextTick(cb)
    }, this.$compiler)
})

function query (el) {
    return typeof el === 'string'
        ? document.querySelector(el)
        : el
}

module.exports = ViewModel
},{"./batcher":2,"./compiler":4,"./transition":24,"./utils":25}],27:[function(require,module,exports){
module.exports = '#app {\n    font-family: \'Helvetica Neue\', Arial, sans-serif;\n}';
},{}],28:[function(require,module,exports){
module.exports = '<h1>{{title}}</h1>\n<component-button>button</component-button>\n<component-panel>\n  <p>Here is some content specified within the panel</p>\n  <component-button>submit</component-button>\n</component-panel>';
},{}],29:[function(require,module,exports){
require('insert-css')(require('./style.css'))

module.exports = {
    tagName: 'component-button',
    template: require('./template.html'),
    data: {
        label: 'Button!'
    },
    replace:true
}
},{"./style.css":30,"./template.html":31,"insert-css":1}],30:[function(require,module,exports){
module.exports = '.component-button {\n    margin: 3px;\n}';
},{}],31:[function(require,module,exports){
module.exports = '<button><content>Default Label</content></button>';
},{}],32:[function(require,module,exports){
require('insert-css')(require('./style.css'))

module.exports = {
    tagName: 'component-panel',
    className: 'component-panel',
    template: require('./template.html'),
    data: {
        headerText: 'Header Info',
        bodyContent: ''
    },
    created: function() {
      console.log(this.$compiler.rawContent.innerHTML);
      this.bodyContent = this.$compiler.rawContent.innerHTML;
    }
}
},{"./style.css":33,"./template.html":34,"insert-css":1}],33:[function(require,module,exports){
module.exports = '.component-panel {\n    border: 1px solid grey;\n    padding: 10px;\n    display: block;\n}';
},{}],34:[function(require,module,exports){
module.exports = '<div>\n  <h3>The following is inserted via content insertion.</h3>\n  <content>This will only be displayed if no content is inserted</content>\n  <h3>The following is inserted via data binding</h3>\n  {{{bodyContent}}}\n</div>\n\n';
},{}],35:[function(require,module,exports){
require('insert-css')(require('./app.css'))

var Vue = require('vue')

new Vue({
    el: '#app',
    components: {
        "component-button": require('./component-button'),
        "component-panel": require('./component-panel')
    },
    // require html enabled by the partialify transform
    template: require('./app.html'),
    data: {
        title: 'Vue content insertion test'
    }
})
},{"./app.css":27,"./app.html":28,"./component-button":29,"./component-panel":32,"insert-css":1,"vue":21}]},{},[35])
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiZ2VuZXJhdGVkLmpzIiwic291cmNlcyI6WyIvVXNlcnMvZHdhYnlpY2svZ2l0aHViL3Z1ZS1icm93c2VyaWZ5LWV4YW1wbGUvbm9kZV9tb2R1bGVzL3dhdGNoaWZ5L25vZGVfbW9kdWxlcy9icm93c2VyaWZ5L25vZGVfbW9kdWxlcy9icm93c2VyLXBhY2svX3ByZWx1ZGUuanMiLCIvVXNlcnMvZHdhYnlpY2svZ2l0aHViL3Z1ZS1icm93c2VyaWZ5LWV4YW1wbGUvbm9kZV9tb2R1bGVzL2luc2VydC1jc3MvaW5kZXguanMiLCIvVXNlcnMvZHdhYnlpY2svZ2l0aHViL3Z1ZS1icm93c2VyaWZ5LWV4YW1wbGUvbm9kZV9tb2R1bGVzL3Z1ZS9zcmMvYmF0Y2hlci5qcyIsIi9Vc2Vycy9kd2FieWljay9naXRodWIvdnVlLWJyb3dzZXJpZnktZXhhbXBsZS9ub2RlX21vZHVsZXMvdnVlL3NyYy9iaW5kaW5nLmpzIiwiL1VzZXJzL2R3YWJ5aWNrL2dpdGh1Yi92dWUtYnJvd3NlcmlmeS1leGFtcGxlL25vZGVfbW9kdWxlcy92dWUvc3JjL2NvbXBpbGVyLmpzIiwiL1VzZXJzL2R3YWJ5aWNrL2dpdGh1Yi92dWUtYnJvd3NlcmlmeS1leGFtcGxlL25vZGVfbW9kdWxlcy92dWUvc3JjL2NvbmZpZy5qcyIsIi9Vc2Vycy9kd2FieWljay9naXRodWIvdnVlLWJyb3dzZXJpZnktZXhhbXBsZS9ub2RlX21vZHVsZXMvdnVlL3NyYy9kZXBzLXBhcnNlci5qcyIsIi9Vc2Vycy9kd2FieWljay9naXRodWIvdnVlLWJyb3dzZXJpZnktZXhhbXBsZS9ub2RlX21vZHVsZXMvdnVlL3NyYy9kaXJlY3RpdmUuanMiLCIvVXNlcnMvZHdhYnlpY2svZ2l0aHViL3Z1ZS1icm93c2VyaWZ5LWV4YW1wbGUvbm9kZV9tb2R1bGVzL3Z1ZS9zcmMvZGlyZWN0aXZlcy9odG1sLmpzIiwiL1VzZXJzL2R3YWJ5aWNrL2dpdGh1Yi92dWUtYnJvd3NlcmlmeS1leGFtcGxlL25vZGVfbW9kdWxlcy92dWUvc3JjL2RpcmVjdGl2ZXMvaWYuanMiLCIvVXNlcnMvZHdhYnlpY2svZ2l0aHViL3Z1ZS1icm93c2VyaWZ5LWV4YW1wbGUvbm9kZV9tb2R1bGVzL3Z1ZS9zcmMvZGlyZWN0aXZlcy9pbmRleC5qcyIsIi9Vc2Vycy9kd2FieWljay9naXRodWIvdnVlLWJyb3dzZXJpZnktZXhhbXBsZS9ub2RlX21vZHVsZXMvdnVlL3NyYy9kaXJlY3RpdmVzL21vZGVsLmpzIiwiL1VzZXJzL2R3YWJ5aWNrL2dpdGh1Yi92dWUtYnJvd3NlcmlmeS1leGFtcGxlL25vZGVfbW9kdWxlcy92dWUvc3JjL2RpcmVjdGl2ZXMvb24uanMiLCIvVXNlcnMvZHdhYnlpY2svZ2l0aHViL3Z1ZS1icm93c2VyaWZ5LWV4YW1wbGUvbm9kZV9tb2R1bGVzL3Z1ZS9zcmMvZGlyZWN0aXZlcy9wYXJ0aWFsLmpzIiwiL1VzZXJzL2R3YWJ5aWNrL2dpdGh1Yi92dWUtYnJvd3NlcmlmeS1leGFtcGxlL25vZGVfbW9kdWxlcy92dWUvc3JjL2RpcmVjdGl2ZXMvcmVwZWF0LmpzIiwiL1VzZXJzL2R3YWJ5aWNrL2dpdGh1Yi92dWUtYnJvd3NlcmlmeS1leGFtcGxlL25vZGVfbW9kdWxlcy92dWUvc3JjL2RpcmVjdGl2ZXMvc3R5bGUuanMiLCIvVXNlcnMvZHdhYnlpY2svZ2l0aHViL3Z1ZS1icm93c2VyaWZ5LWV4YW1wbGUvbm9kZV9tb2R1bGVzL3Z1ZS9zcmMvZGlyZWN0aXZlcy92aWV3LmpzIiwiL1VzZXJzL2R3YWJ5aWNrL2dpdGh1Yi92dWUtYnJvd3NlcmlmeS1leGFtcGxlL25vZGVfbW9kdWxlcy92dWUvc3JjL2RpcmVjdGl2ZXMvd2l0aC5qcyIsIi9Vc2Vycy9kd2FieWljay9naXRodWIvdnVlLWJyb3dzZXJpZnktZXhhbXBsZS9ub2RlX21vZHVsZXMvdnVlL3NyYy9lbWl0dGVyLmpzIiwiL1VzZXJzL2R3YWJ5aWNrL2dpdGh1Yi92dWUtYnJvd3NlcmlmeS1leGFtcGxlL25vZGVfbW9kdWxlcy92dWUvc3JjL2V4cC1wYXJzZXIuanMiLCIvVXNlcnMvZHdhYnlpY2svZ2l0aHViL3Z1ZS1icm93c2VyaWZ5LWV4YW1wbGUvbm9kZV9tb2R1bGVzL3Z1ZS9zcmMvZmlsdGVycy5qcyIsIi9Vc2Vycy9kd2FieWljay9naXRodWIvdnVlLWJyb3dzZXJpZnktZXhhbXBsZS9ub2RlX21vZHVsZXMvdnVlL3NyYy9tYWluLmpzIiwiL1VzZXJzL2R3YWJ5aWNrL2dpdGh1Yi92dWUtYnJvd3NlcmlmeS1leGFtcGxlL25vZGVfbW9kdWxlcy92dWUvc3JjL29ic2VydmVyLmpzIiwiL1VzZXJzL2R3YWJ5aWNrL2dpdGh1Yi92dWUtYnJvd3NlcmlmeS1leGFtcGxlL25vZGVfbW9kdWxlcy92dWUvc3JjL3RleHQtcGFyc2VyLmpzIiwiL1VzZXJzL2R3YWJ5aWNrL2dpdGh1Yi92dWUtYnJvd3NlcmlmeS1leGFtcGxlL25vZGVfbW9kdWxlcy92dWUvc3JjL3RyYW5zaXRpb24uanMiLCIvVXNlcnMvZHdhYnlpY2svZ2l0aHViL3Z1ZS1icm93c2VyaWZ5LWV4YW1wbGUvbm9kZV9tb2R1bGVzL3Z1ZS9zcmMvdXRpbHMuanMiLCIvVXNlcnMvZHdhYnlpY2svZ2l0aHViL3Z1ZS1icm93c2VyaWZ5LWV4YW1wbGUvbm9kZV9tb2R1bGVzL3Z1ZS9zcmMvdmlld21vZGVsLmpzIiwiL1VzZXJzL2R3YWJ5aWNrL2dpdGh1Yi92dWUtYnJvd3NlcmlmeS1leGFtcGxlL3NyYy9hcHAuY3NzIiwiL1VzZXJzL2R3YWJ5aWNrL2dpdGh1Yi92dWUtYnJvd3NlcmlmeS1leGFtcGxlL3NyYy9hcHAuaHRtbCIsIi9Vc2Vycy9kd2FieWljay9naXRodWIvdnVlLWJyb3dzZXJpZnktZXhhbXBsZS9zcmMvY29tcG9uZW50LWJ1dHRvbi9pbmRleC5qcyIsIi9Vc2Vycy9kd2FieWljay9naXRodWIvdnVlLWJyb3dzZXJpZnktZXhhbXBsZS9zcmMvY29tcG9uZW50LWJ1dHRvbi9zdHlsZS5jc3MiLCIvVXNlcnMvZHdhYnlpY2svZ2l0aHViL3Z1ZS1icm93c2VyaWZ5LWV4YW1wbGUvc3JjL2NvbXBvbmVudC1idXR0b24vdGVtcGxhdGUuaHRtbCIsIi9Vc2Vycy9kd2FieWljay9naXRodWIvdnVlLWJyb3dzZXJpZnktZXhhbXBsZS9zcmMvY29tcG9uZW50LXBhbmVsL2luZGV4LmpzIiwiL1VzZXJzL2R3YWJ5aWNrL2dpdGh1Yi92dWUtYnJvd3NlcmlmeS1leGFtcGxlL3NyYy9jb21wb25lbnQtcGFuZWwvc3R5bGUuY3NzIiwiL1VzZXJzL2R3YWJ5aWNrL2dpdGh1Yi92dWUtYnJvd3NlcmlmeS1leGFtcGxlL3NyYy9jb21wb25lbnQtcGFuZWwvdGVtcGxhdGUuaHRtbCIsIi9Vc2Vycy9kd2FieWljay9naXRodWIvdnVlLWJyb3dzZXJpZnktZXhhbXBsZS9zcmMvbWFpbi5qcyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQTtBQ0FBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ2xCQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDNUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ3RHQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ3YvQkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDbEJBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDaEVBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ2xRQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDekNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDdkRBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUNoSUE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQzdLQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUNwQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUNqREE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDL1BBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDM0NBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDdkRBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDakRBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ3hFQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUM3TEE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDN0xBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUN0TEE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDL2JBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDOUZBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ2pPQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUN2VUE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQzdLQTs7QUNBQTs7QUNBQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUNUQTs7QUNBQTs7QUNBQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDZEE7O0FDQUE7O0FDQUE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0EiLCJzb3VyY2VzQ29udGVudCI6WyIoZnVuY3Rpb24gZSh0LG4scil7ZnVuY3Rpb24gcyhvLHUpe2lmKCFuW29dKXtpZighdFtvXSl7dmFyIGE9dHlwZW9mIHJlcXVpcmU9PVwiZnVuY3Rpb25cIiYmcmVxdWlyZTtpZighdSYmYSlyZXR1cm4gYShvLCEwKTtpZihpKXJldHVybiBpKG8sITApO3Rocm93IG5ldyBFcnJvcihcIkNhbm5vdCBmaW5kIG1vZHVsZSAnXCIrbytcIidcIil9dmFyIGY9bltvXT17ZXhwb3J0czp7fX07dFtvXVswXS5jYWxsKGYuZXhwb3J0cyxmdW5jdGlvbihlKXt2YXIgbj10W29dWzFdW2VdO3JldHVybiBzKG4/bjplKX0sZixmLmV4cG9ydHMsZSx0LG4scil9cmV0dXJuIG5bb10uZXhwb3J0c312YXIgaT10eXBlb2YgcmVxdWlyZT09XCJmdW5jdGlvblwiJiZyZXF1aXJlO2Zvcih2YXIgbz0wO288ci5sZW5ndGg7bysrKXMocltvXSk7cmV0dXJuIHN9KSIsInZhciBpbnNlcnRlZCA9IHt9O1xuXG5tb2R1bGUuZXhwb3J0cyA9IGZ1bmN0aW9uIChjc3MpIHtcbiAgICBpZiAoaW5zZXJ0ZWRbY3NzXSkgcmV0dXJuO1xuICAgIGluc2VydGVkW2Nzc10gPSB0cnVlO1xuICAgIFxuICAgIHZhciBlbGVtID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnc3R5bGUnKTtcbiAgICBlbGVtLnNldEF0dHJpYnV0ZSgndHlwZScsICd0ZXh0L2NzcycpO1xuXG4gICAgaWYgKCd0ZXh0Q29udGVudCcgaW4gZWxlbSkge1xuICAgICAgZWxlbS50ZXh0Q29udGVudCA9IGNzcztcbiAgICB9IGVsc2Uge1xuICAgICAgZWxlbS5zdHlsZVNoZWV0LmNzc1RleHQgPSBjc3M7XG4gICAgfVxuICAgIFxuICAgIHZhciBoZWFkID0gZG9jdW1lbnQuZ2V0RWxlbWVudHNCeVRhZ05hbWUoJ2hlYWQnKVswXTtcbiAgICBoZWFkLmFwcGVuZENoaWxkKGVsZW0pO1xufTtcbiIsInZhciB1dGlscyA9IHJlcXVpcmUoJy4vdXRpbHMnKVxuXG5mdW5jdGlvbiBCYXRjaGVyICgpIHtcbiAgICB0aGlzLnJlc2V0KClcbn1cblxudmFyIEJhdGNoZXJQcm90byA9IEJhdGNoZXIucHJvdG90eXBlXG5cbkJhdGNoZXJQcm90by5wdXNoID0gZnVuY3Rpb24gKGpvYikge1xuICAgIGlmICgham9iLmlkIHx8ICF0aGlzLmhhc1tqb2IuaWRdKSB7XG4gICAgICAgIHRoaXMucXVldWUucHVzaChqb2IpXG4gICAgICAgIHRoaXMuaGFzW2pvYi5pZF0gPSBqb2JcbiAgICAgICAgaWYgKCF0aGlzLndhaXRpbmcpIHtcbiAgICAgICAgICAgIHRoaXMud2FpdGluZyA9IHRydWVcbiAgICAgICAgICAgIHV0aWxzLm5leHRUaWNrKHV0aWxzLmJpbmQodGhpcy5mbHVzaCwgdGhpcykpXG4gICAgICAgIH1cbiAgICB9IGVsc2UgaWYgKGpvYi5vdmVycmlkZSkge1xuICAgICAgICB2YXIgb2xkSm9iID0gdGhpcy5oYXNbam9iLmlkXVxuICAgICAgICBvbGRKb2IuY2FuY2VsbGVkID0gdHJ1ZVxuICAgICAgICB0aGlzLnF1ZXVlLnB1c2goam9iKVxuICAgICAgICB0aGlzLmhhc1tqb2IuaWRdID0gam9iXG4gICAgfVxufVxuXG5CYXRjaGVyUHJvdG8uZmx1c2ggPSBmdW5jdGlvbiAoKSB7XG4gICAgLy8gYmVmb3JlIGZsdXNoIGhvb2tcbiAgICBpZiAodGhpcy5fcHJlRmx1c2gpIHRoaXMuX3ByZUZsdXNoKClcbiAgICAvLyBkbyBub3QgY2FjaGUgbGVuZ3RoIGJlY2F1c2UgbW9yZSBqb2JzIG1pZ2h0IGJlIHB1c2hlZFxuICAgIC8vIGFzIHdlIGV4ZWN1dGUgZXhpc3Rpbmcgam9ic1xuICAgIGZvciAodmFyIGkgPSAwOyBpIDwgdGhpcy5xdWV1ZS5sZW5ndGg7IGkrKykge1xuICAgICAgICB2YXIgam9iID0gdGhpcy5xdWV1ZVtpXVxuICAgICAgICBpZiAoIWpvYi5jYW5jZWxsZWQpIHtcbiAgICAgICAgICAgIGpvYi5leGVjdXRlKClcbiAgICAgICAgfVxuICAgIH1cbiAgICB0aGlzLnJlc2V0KClcbn1cblxuQmF0Y2hlclByb3RvLnJlc2V0ID0gZnVuY3Rpb24gKCkge1xuICAgIHRoaXMuaGFzID0gdXRpbHMuaGFzaCgpXG4gICAgdGhpcy5xdWV1ZSA9IFtdXG4gICAgdGhpcy53YWl0aW5nID0gZmFsc2Vcbn1cblxubW9kdWxlLmV4cG9ydHMgPSBCYXRjaGVyIiwidmFyIEJhdGNoZXIgICAgICAgID0gcmVxdWlyZSgnLi9iYXRjaGVyJyksXG4gICAgYmluZGluZ0JhdGNoZXIgPSBuZXcgQmF0Y2hlcigpLFxuICAgIGJpbmRpbmdJZCAgICAgID0gMVxuXG4vKipcbiAqICBCaW5kaW5nIGNsYXNzLlxuICpcbiAqICBlYWNoIHByb3BlcnR5IG9uIHRoZSB2aWV3bW9kZWwgaGFzIG9uZSBjb3JyZXNwb25kaW5nIEJpbmRpbmcgb2JqZWN0XG4gKiAgd2hpY2ggaGFzIG11bHRpcGxlIGRpcmVjdGl2ZSBpbnN0YW5jZXMgb24gdGhlIERPTVxuICogIGFuZCBtdWx0aXBsZSBjb21wdXRlZCBwcm9wZXJ0eSBkZXBlbmRlbnRzXG4gKi9cbmZ1bmN0aW9uIEJpbmRpbmcgKGNvbXBpbGVyLCBrZXksIGlzRXhwLCBpc0ZuKSB7XG4gICAgdGhpcy5pZCA9IGJpbmRpbmdJZCsrXG4gICAgdGhpcy52YWx1ZSA9IHVuZGVmaW5lZFxuICAgIHRoaXMuaXNFeHAgPSAhIWlzRXhwXG4gICAgdGhpcy5pc0ZuID0gaXNGblxuICAgIHRoaXMucm9vdCA9ICF0aGlzLmlzRXhwICYmIGtleS5pbmRleE9mKCcuJykgPT09IC0xXG4gICAgdGhpcy5jb21waWxlciA9IGNvbXBpbGVyXG4gICAgdGhpcy5rZXkgPSBrZXlcbiAgICB0aGlzLmRpcnMgPSBbXVxuICAgIHRoaXMuc3VicyA9IFtdXG4gICAgdGhpcy5kZXBzID0gW11cbiAgICB0aGlzLnVuYm91bmQgPSBmYWxzZVxufVxuXG52YXIgQmluZGluZ1Byb3RvID0gQmluZGluZy5wcm90b3R5cGVcblxuLyoqXG4gKiAgVXBkYXRlIHZhbHVlIGFuZCBxdWV1ZSBpbnN0YW5jZSB1cGRhdGVzLlxuICovXG5CaW5kaW5nUHJvdG8udXBkYXRlID0gZnVuY3Rpb24gKHZhbHVlKSB7XG4gICAgaWYgKCF0aGlzLmlzQ29tcHV0ZWQgfHwgdGhpcy5pc0ZuKSB7XG4gICAgICAgIHRoaXMudmFsdWUgPSB2YWx1ZVxuICAgIH1cbiAgICBpZiAodGhpcy5kaXJzLmxlbmd0aCB8fCB0aGlzLnN1YnMubGVuZ3RoKSB7XG4gICAgICAgIHZhciBzZWxmID0gdGhpc1xuICAgICAgICBiaW5kaW5nQmF0Y2hlci5wdXNoKHtcbiAgICAgICAgICAgIGlkOiB0aGlzLmlkLFxuICAgICAgICAgICAgZXhlY3V0ZTogZnVuY3Rpb24gKCkge1xuICAgICAgICAgICAgICAgIGlmICghc2VsZi51bmJvdW5kKSB7XG4gICAgICAgICAgICAgICAgICAgIHNlbGYuX3VwZGF0ZSgpXG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuICAgICAgICB9KVxuICAgIH1cbn1cblxuLyoqXG4gKiAgQWN0dWFsbHkgdXBkYXRlIHRoZSBkaXJlY3RpdmVzLlxuICovXG5CaW5kaW5nUHJvdG8uX3VwZGF0ZSA9IGZ1bmN0aW9uICgpIHtcbiAgICB2YXIgaSA9IHRoaXMuZGlycy5sZW5ndGgsXG4gICAgICAgIHZhbHVlID0gdGhpcy52YWwoKVxuICAgIHdoaWxlIChpLS0pIHtcbiAgICAgICAgdGhpcy5kaXJzW2ldLnVwZGF0ZSh2YWx1ZSlcbiAgICB9XG4gICAgdGhpcy5wdWIoKVxufVxuXG4vKipcbiAqICBSZXR1cm4gdGhlIHZhbHVhdGVkIHZhbHVlIHJlZ2FyZGxlc3NcbiAqICBvZiB3aGV0aGVyIGl0IGlzIGNvbXB1dGVkIG9yIG5vdFxuICovXG5CaW5kaW5nUHJvdG8udmFsID0gZnVuY3Rpb24gKCkge1xuICAgIHJldHVybiB0aGlzLmlzQ29tcHV0ZWQgJiYgIXRoaXMuaXNGblxuICAgICAgICA/IHRoaXMudmFsdWUuJGdldCgpXG4gICAgICAgIDogdGhpcy52YWx1ZVxufVxuXG4vKipcbiAqICBOb3RpZnkgY29tcHV0ZWQgcHJvcGVydGllcyB0aGF0IGRlcGVuZCBvbiB0aGlzIGJpbmRpbmdcbiAqICB0byB1cGRhdGUgdGhlbXNlbHZlc1xuICovXG5CaW5kaW5nUHJvdG8ucHViID0gZnVuY3Rpb24gKCkge1xuICAgIHZhciBpID0gdGhpcy5zdWJzLmxlbmd0aFxuICAgIHdoaWxlIChpLS0pIHtcbiAgICAgICAgdGhpcy5zdWJzW2ldLnVwZGF0ZSgpXG4gICAgfVxufVxuXG4vKipcbiAqICBVbmJpbmQgdGhlIGJpbmRpbmcsIHJlbW92ZSBpdHNlbGYgZnJvbSBhbGwgb2YgaXRzIGRlcGVuZGVuY2llc1xuICovXG5CaW5kaW5nUHJvdG8udW5iaW5kID0gZnVuY3Rpb24gKCkge1xuICAgIC8vIEluZGljYXRlIHRoaXMgaGFzIGJlZW4gdW5ib3VuZC5cbiAgICAvLyBJdCdzIHBvc3NpYmxlIHRoaXMgYmluZGluZyB3aWxsIGJlIGluXG4gICAgLy8gdGhlIGJhdGNoZXIncyBmbHVzaCBxdWV1ZSB3aGVuIGl0cyBvd25lclxuICAgIC8vIGNvbXBpbGVyIGhhcyBhbHJlYWR5IGJlZW4gZGVzdHJveWVkLlxuICAgIHRoaXMudW5ib3VuZCA9IHRydWVcbiAgICB2YXIgaSA9IHRoaXMuZGlycy5sZW5ndGhcbiAgICB3aGlsZSAoaS0tKSB7XG4gICAgICAgIHRoaXMuZGlyc1tpXS51bmJpbmQoKVxuICAgIH1cbiAgICBpID0gdGhpcy5kZXBzLmxlbmd0aFxuICAgIHZhciBzdWJzXG4gICAgd2hpbGUgKGktLSkge1xuICAgICAgICBzdWJzID0gdGhpcy5kZXBzW2ldLnN1YnNcbiAgICAgICAgdmFyIGogPSBzdWJzLmluZGV4T2YodGhpcylcbiAgICAgICAgaWYgKGogPiAtMSkgc3Vicy5zcGxpY2UoaiwgMSlcbiAgICB9XG59XG5cbm1vZHVsZS5leHBvcnRzID0gQmluZGluZyIsInZhciBFbWl0dGVyICAgICA9IHJlcXVpcmUoJy4vZW1pdHRlcicpLFxuICAgIE9ic2VydmVyICAgID0gcmVxdWlyZSgnLi9vYnNlcnZlcicpLFxuICAgIGNvbmZpZyAgICAgID0gcmVxdWlyZSgnLi9jb25maWcnKSxcbiAgICB1dGlscyAgICAgICA9IHJlcXVpcmUoJy4vdXRpbHMnKSxcbiAgICBCaW5kaW5nICAgICA9IHJlcXVpcmUoJy4vYmluZGluZycpLFxuICAgIERpcmVjdGl2ZSAgID0gcmVxdWlyZSgnLi9kaXJlY3RpdmUnKSxcbiAgICBUZXh0UGFyc2VyICA9IHJlcXVpcmUoJy4vdGV4dC1wYXJzZXInKSxcbiAgICBEZXBzUGFyc2VyICA9IHJlcXVpcmUoJy4vZGVwcy1wYXJzZXInKSxcbiAgICBFeHBQYXJzZXIgICA9IHJlcXVpcmUoJy4vZXhwLXBhcnNlcicpLFxuICAgIFZpZXdNb2RlbCxcbiAgICBcbiAgICAvLyBjYWNoZSBtZXRob2RzXG4gICAgc2xpY2UgICAgICAgPSBbXS5zbGljZSxcbiAgICBleHRlbmQgICAgICA9IHV0aWxzLmV4dGVuZCxcbiAgICBoYXNPd24gICAgICA9ICh7fSkuaGFzT3duUHJvcGVydHksXG4gICAgZGVmICAgICAgICAgPSBPYmplY3QuZGVmaW5lUHJvcGVydHksXG5cbiAgICAvLyBob29rcyB0byByZWdpc3RlclxuICAgIGhvb2tzID0gW1xuICAgICAgICAnY3JlYXRlZCcsICdyZWFkeScsXG4gICAgICAgICdiZWZvcmVEZXN0cm95JywgJ2FmdGVyRGVzdHJveScsXG4gICAgICAgICdhdHRhY2hlZCcsICdkZXRhY2hlZCdcbiAgICBdLFxuXG4gICAgLy8gbGlzdCBvZiBwcmlvcml0eSBkaXJlY3RpdmVzXG4gICAgLy8gdGhhdCBuZWVkcyB0byBiZSBjaGVja2VkIGluIHNwZWNpZmljIG9yZGVyXG4gICAgcHJpb3JpdHlEaXJlY3RpdmVzID0gW1xuICAgICAgICAnaWYnLFxuICAgICAgICAncmVwZWF0JyxcbiAgICAgICAgJ3ZpZXcnLFxuICAgICAgICAnY29tcG9uZW50J1xuICAgIF1cblxuLyoqXG4gKiAgVGhlIERPTSBjb21waWxlclxuICogIHNjYW5zIGEgRE9NIG5vZGUgYW5kIGNvbXBpbGUgYmluZGluZ3MgZm9yIGEgVmlld01vZGVsXG4gKi9cbmZ1bmN0aW9uIENvbXBpbGVyICh2bSwgb3B0aW9ucykge1xuXG4gICAgdmFyIGNvbXBpbGVyID0gdGhpcyxcbiAgICAgICAga2V5LCBpXG5cbiAgICAvLyBkZWZhdWx0IHN0YXRlXG4gICAgY29tcGlsZXIuaW5pdCAgICAgICA9IHRydWVcbiAgICBjb21waWxlci5kZXN0cm95ZWQgID0gZmFsc2VcblxuICAgIC8vIHByb2Nlc3MgYW5kIGV4dGVuZCBvcHRpb25zXG4gICAgb3B0aW9ucyA9IGNvbXBpbGVyLm9wdGlvbnMgPSBvcHRpb25zIHx8IHt9XG4gICAgdXRpbHMucHJvY2Vzc09wdGlvbnMob3B0aW9ucylcblxuICAgIC8vIGNvcHkgY29tcGlsZXIgb3B0aW9uc1xuICAgIGV4dGVuZChjb21waWxlciwgb3B0aW9ucy5jb21waWxlck9wdGlvbnMpXG4gICAgLy8gcmVwZWF0IGluZGljYXRlcyB0aGlzIGlzIGEgdi1yZXBlYXQgaW5zdGFuY2VcbiAgICBjb21waWxlci5yZXBlYXQgICA9IGNvbXBpbGVyLnJlcGVhdCB8fCBmYWxzZVxuICAgIC8vIGV4cENhY2hlIHdpbGwgYmUgc2hhcmVkIGJldHdlZW4gdi1yZXBlYXQgaW5zdGFuY2VzXG4gICAgY29tcGlsZXIuZXhwQ2FjaGUgPSBjb21waWxlci5leHBDYWNoZSB8fCB7fVxuXG4gICAgLy8gaW5pdGlhbGl6ZSBlbGVtZW50XG4gICAgdmFyIGVsID0gY29tcGlsZXIuZWwgPSBjb21waWxlci5zZXR1cEVsZW1lbnQob3B0aW9ucylcbiAgICB1dGlscy5sb2coJ1xcbm5ldyBWTSBpbnN0YW5jZTogJyArIGVsLnRhZ05hbWUgKyAnXFxuJylcblxuICAgIC8vIHNldCBvdGhlciBjb21waWxlciBwcm9wZXJ0aWVzXG4gICAgY29tcGlsZXIudm0gICAgICAgPSBlbC52dWVfdm0gPSB2bVxuICAgIGNvbXBpbGVyLmJpbmRpbmdzID0gdXRpbHMuaGFzaCgpXG4gICAgY29tcGlsZXIuZGlycyAgICAgPSBbXVxuICAgIGNvbXBpbGVyLmRlZmVycmVkID0gW11cbiAgICBjb21waWxlci5jb21wdXRlZCA9IFtdXG4gICAgY29tcGlsZXIuY2hpbGRyZW4gPSBbXVxuICAgIGNvbXBpbGVyLmVtaXR0ZXIgID0gbmV3IEVtaXR0ZXIodm0pXG5cbiAgICAvLyBjcmVhdGUgYmluZGluZ3MgZm9yIGNvbXB1dGVkIHByb3BlcnRpZXNcbiAgICBpZiAob3B0aW9ucy5tZXRob2RzKSB7XG4gICAgICAgIGZvciAoa2V5IGluIG9wdGlvbnMubWV0aG9kcykge1xuICAgICAgICAgICAgY29tcGlsZXIuY3JlYXRlQmluZGluZyhrZXkpXG4gICAgICAgIH1cbiAgICB9XG5cbiAgICAvLyBjcmVhdGUgYmluZGluZ3MgZm9yIG1ldGhvZHNcbiAgICBpZiAob3B0aW9ucy5jb21wdXRlZCkge1xuICAgICAgICBmb3IgKGtleSBpbiBvcHRpb25zLmNvbXB1dGVkKSB7XG4gICAgICAgICAgICBjb21waWxlci5jcmVhdGVCaW5kaW5nKGtleSlcbiAgICAgICAgfVxuICAgIH1cblxuICAgIC8vIFZNIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXG4gICAgLy8gc2V0IFZNIHByb3BlcnRpZXNcbiAgICB2bS4kICAgICAgICAgPSB7fVxuICAgIHZtLiRlbCAgICAgICA9IGVsXG4gICAgdm0uJG9wdGlvbnMgID0gb3B0aW9uc1xuICAgIHZtLiRjb21waWxlciA9IGNvbXBpbGVyXG4gICAgdm0uJGV2ZW50ICAgID0gbnVsbFxuXG4gICAgLy8gc2V0IHBhcmVudCAmIHJvb3RcbiAgICB2YXIgcGFyZW50Vk0gPSBvcHRpb25zLnBhcmVudFxuICAgIGlmIChwYXJlbnRWTSkge1xuICAgICAgICBjb21waWxlci5wYXJlbnQgPSBwYXJlbnRWTS4kY29tcGlsZXJcbiAgICAgICAgcGFyZW50Vk0uJGNvbXBpbGVyLmNoaWxkcmVuLnB1c2goY29tcGlsZXIpXG4gICAgICAgIHZtLiRwYXJlbnQgPSBwYXJlbnRWTVxuICAgIH1cbiAgICB2bS4kcm9vdCA9IGdldFJvb3QoY29tcGlsZXIpLnZtXG5cbiAgICAvLyBEQVRBIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuICAgIC8vIHNldHVwIG9ic2VydmVyXG4gICAgLy8gdGhpcyBpcyBuZWNlc2FycnkgZm9yIGFsbCBob29rcyBhbmQgZGF0YSBvYnNlcnZhdGlvbiBldmVudHNcbiAgICBjb21waWxlci5zZXR1cE9ic2VydmVyKClcblxuICAgIC8vIGluaXRpYWxpemUgZGF0YVxuICAgIHZhciBkYXRhID0gY29tcGlsZXIuZGF0YSA9IG9wdGlvbnMuZGF0YSB8fCB7fSxcbiAgICAgICAgZGVmYXVsdERhdGEgPSBvcHRpb25zLmRlZmF1bHREYXRhXG4gICAgaWYgKGRlZmF1bHREYXRhKSB7XG4gICAgICAgIGZvciAoa2V5IGluIGRlZmF1bHREYXRhKSB7XG4gICAgICAgICAgICBpZiAoIWhhc093bi5jYWxsKGRhdGEsIGtleSkpIHtcbiAgICAgICAgICAgICAgICBkYXRhW2tleV0gPSBkZWZhdWx0RGF0YVtrZXldXG4gICAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICAvLyBjb3B5IHBhcmFtQXR0cmlidXRlc1xuICAgIHZhciBwYXJhbXMgPSBvcHRpb25zLnBhcmFtQXR0cmlidXRlc1xuICAgIGlmIChwYXJhbXMpIHtcbiAgICAgICAgaSA9IHBhcmFtcy5sZW5ndGhcbiAgICAgICAgd2hpbGUgKGktLSkge1xuICAgICAgICAgICAgZGF0YVtwYXJhbXNbaV1dID0gdXRpbHMuY2hlY2tOdW1iZXIoXG4gICAgICAgICAgICAgICAgY29tcGlsZXIuZXZhbChcbiAgICAgICAgICAgICAgICAgICAgZWwuZ2V0QXR0cmlidXRlKHBhcmFtc1tpXSlcbiAgICAgICAgICAgICAgICApXG4gICAgICAgICAgICApXG4gICAgICAgIH1cbiAgICB9XG5cbiAgICAvLyBjb3B5IGRhdGEgcHJvcGVydGllcyB0byB2bVxuICAgIC8vIHNvIHVzZXIgY2FuIGFjY2VzcyB0aGVtIGluIHRoZSBjcmVhdGVkIGhvb2tcbiAgICBleHRlbmQodm0sIGRhdGEpXG4gICAgdm0uJGRhdGEgPSBkYXRhXG5cbiAgICAvLyBiZWZvcmVDb21waWxlIGhvb2tcbiAgICBjb21waWxlci5leGVjSG9vaygnY3JlYXRlZCcpXG5cbiAgICAvLyB0aGUgdXNlciBtaWdodCBoYXZlIHN3YXBwZWQgdGhlIGRhdGEgLi4uXG4gICAgZGF0YSA9IGNvbXBpbGVyLmRhdGEgPSB2bS4kZGF0YVxuXG4gICAgLy8gdXNlciBtaWdodCBhbHNvIHNldCBzb21lIHByb3BlcnRpZXMgb24gdGhlIHZtXG4gICAgLy8gaW4gd2hpY2ggY2FzZSB3ZSBzaG91bGQgY29weSBiYWNrIHRvICRkYXRhXG4gICAgdmFyIHZtUHJvcFxuICAgIGZvciAoa2V5IGluIHZtKSB7XG4gICAgICAgIHZtUHJvcCA9IHZtW2tleV1cbiAgICAgICAgaWYgKFxuICAgICAgICAgICAga2V5LmNoYXJBdCgwKSAhPT0gJyQnICYmXG4gICAgICAgICAgICBkYXRhW2tleV0gIT09IHZtUHJvcCAmJlxuICAgICAgICAgICAgdHlwZW9mIHZtUHJvcCAhPT0gJ2Z1bmN0aW9uJ1xuICAgICAgICApIHtcbiAgICAgICAgICAgIGRhdGFba2V5XSA9IHZtUHJvcFxuICAgICAgICB9XG4gICAgfVxuXG4gICAgLy8gbm93IHdlIGNhbiBvYnNlcnZlIHRoZSBkYXRhLlxuICAgIC8vIHRoaXMgd2lsbCBjb252ZXJ0IGRhdGEgcHJvcGVydGllcyB0byBnZXR0ZXIvc2V0dGVyc1xuICAgIC8vIGFuZCBlbWl0IHRoZSBmaXJzdCBiYXRjaCBvZiBzZXQgZXZlbnRzLCB3aGljaCB3aWxsXG4gICAgLy8gaW4gdHVybiBjcmVhdGUgdGhlIGNvcnJlc3BvbmRpbmcgYmluZGluZ3MuXG4gICAgY29tcGlsZXIub2JzZXJ2ZURhdGEoZGF0YSlcblxuICAgIC8vIENPTVBJTEUgLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXG4gICAgLy8gYmVmb3JlIGNvbXBpbGluZywgcmVzb2x2ZSBjb250ZW50IGluc2VydGlvbiBwb2ludHNcbiAgICBpZiAob3B0aW9ucy50ZW1wbGF0ZSkge1xuICAgICAgICB0aGlzLnJlc29sdmVDb250ZW50KClcbiAgICB9XG5cbiAgICAvLyBub3cgcGFyc2UgdGhlIERPTSBhbmQgYmluZCBkaXJlY3RpdmVzLlxuICAgIC8vIER1cmluZyB0aGlzIHN0YWdlLCB3ZSB3aWxsIGFsc28gY3JlYXRlIGJpbmRpbmdzIGZvclxuICAgIC8vIGVuY291bnRlcmVkIGtleXBhdGhzIHRoYXQgZG9uJ3QgaGF2ZSBhIGJpbmRpbmcgeWV0LlxuICAgIGNvbXBpbGVyLmNvbXBpbGUoZWwsIHRydWUpXG5cbiAgICAvLyBBbnkgZGlyZWN0aXZlIHRoYXQgY3JlYXRlcyBjaGlsZCBWTXMgYXJlIGRlZmVycmVkXG4gICAgLy8gc28gdGhhdCB3aGVuIHRoZXkgYXJlIGNvbXBpbGVkLCBhbGwgYmluZGluZ3Mgb24gdGhlXG4gICAgLy8gcGFyZW50IFZNIGhhdmUgYmVlbiBjcmVhdGVkLlxuICAgIGkgPSBjb21waWxlci5kZWZlcnJlZC5sZW5ndGhcbiAgICB3aGlsZSAoaS0tKSB7XG4gICAgICAgIGNvbXBpbGVyLmJpbmREaXJlY3RpdmUoY29tcGlsZXIuZGVmZXJyZWRbaV0pXG4gICAgfVxuICAgIGNvbXBpbGVyLmRlZmVycmVkID0gbnVsbFxuXG4gICAgLy8gZXh0cmFjdCBkZXBlbmRlbmNpZXMgZm9yIGNvbXB1dGVkIHByb3BlcnRpZXMuXG4gICAgLy8gdGhpcyB3aWxsIGV2YWx1YXRlZCBhbGwgY29sbGVjdGVkIGNvbXB1dGVkIGJpbmRpbmdzXG4gICAgLy8gYW5kIGNvbGxlY3QgZ2V0IGV2ZW50cyB0aGF0IGFyZSBlbWl0dGVkLlxuICAgIGlmICh0aGlzLmNvbXB1dGVkLmxlbmd0aCkge1xuICAgICAgICBEZXBzUGFyc2VyLnBhcnNlKHRoaXMuY29tcHV0ZWQpXG4gICAgfVxuXG4gICAgLy8gZG9uZSFcbiAgICBjb21waWxlci5pbml0ID0gZmFsc2VcblxuICAgIC8vIHBvc3QgY29tcGlsZSAvIHJlYWR5IGhvb2tcbiAgICBjb21waWxlci5leGVjSG9vaygncmVhZHknKVxufVxuXG52YXIgQ29tcGlsZXJQcm90byA9IENvbXBpbGVyLnByb3RvdHlwZVxuXG4vKipcbiAqICBJbml0aWFsaXplIHRoZSBWTS9Db21waWxlcidzIGVsZW1lbnQuXG4gKiAgRmlsbCBpdCBpbiB3aXRoIHRoZSB0ZW1wbGF0ZSBpZiBuZWNlc3NhcnkuXG4gKi9cbkNvbXBpbGVyUHJvdG8uc2V0dXBFbGVtZW50ID0gZnVuY3Rpb24gKG9wdGlvbnMpIHtcbiAgICAvLyBjcmVhdGUgdGhlIG5vZGUgZmlyc3RcbiAgICB2YXIgZWwgPSB0eXBlb2Ygb3B0aW9ucy5lbCA9PT0gJ3N0cmluZydcbiAgICAgICAgPyBkb2N1bWVudC5xdWVyeVNlbGVjdG9yKG9wdGlvbnMuZWwpXG4gICAgICAgIDogb3B0aW9ucy5lbCB8fCBkb2N1bWVudC5jcmVhdGVFbGVtZW50KG9wdGlvbnMudGFnTmFtZSB8fCAnZGl2JylcblxuICAgIHZhciB0ZW1wbGF0ZSA9IG9wdGlvbnMudGVtcGxhdGUsXG4gICAgICAgIGNoaWxkLCByZXBsYWNlciwgaSwgYXR0ciwgYXR0cnNcblxuICAgIGlmICh0ZW1wbGF0ZSkge1xuICAgICAgICAvLyBjb2xsZWN0IGFueXRoaW5nIGFscmVhZHkgaW4gdGhlcmVcbiAgICAgICAgaWYgKGVsLmhhc0NoaWxkTm9kZXMoKSkge1xuICAgICAgICAgICAgdGhpcy5yYXdDb250ZW50ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnZGl2JylcbiAgICAgICAgICAgIC8qIGpzaGludCBib3NzOiB0cnVlICovXG4gICAgICAgICAgICB3aGlsZSAoY2hpbGQgPSBlbC5maXJzdENoaWxkKSB7XG4gICAgICAgICAgICAgICAgdGhpcy5yYXdDb250ZW50LmFwcGVuZENoaWxkKGNoaWxkKVxuICAgICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICAgIC8vIHJlcGxhY2Ugb3B0aW9uOiB1c2UgdGhlIGZpcnN0IG5vZGUgaW5cbiAgICAgICAgLy8gdGhlIHRlbXBsYXRlIGRpcmVjdGx5XG4gICAgICAgIGlmIChvcHRpb25zLnJlcGxhY2UgJiYgdGVtcGxhdGUuY2hpbGROb2Rlcy5sZW5ndGggPT09IDEpIHtcbiAgICAgICAgICAgIHJlcGxhY2VyID0gdGVtcGxhdGUuY2hpbGROb2Rlc1swXS5jbG9uZU5vZGUodHJ1ZSlcbiAgICAgICAgICAgIGlmIChlbC5wYXJlbnROb2RlKSB7XG4gICAgICAgICAgICAgICAgZWwucGFyZW50Tm9kZS5pbnNlcnRCZWZvcmUocmVwbGFjZXIsIGVsKVxuICAgICAgICAgICAgICAgIGVsLnBhcmVudE5vZGUucmVtb3ZlQ2hpbGQoZWwpXG4gICAgICAgICAgICB9XG4gICAgICAgICAgICAvLyBjb3B5IG92ZXIgYXR0cmlidXRlc1xuICAgICAgICAgICAgaWYgKGVsLmhhc0F0dHJpYnV0ZXMoKSkge1xuICAgICAgICAgICAgICAgIGkgPSBlbC5hdHRyaWJ1dGVzLmxlbmd0aFxuICAgICAgICAgICAgICAgIHdoaWxlIChpLS0pIHtcbiAgICAgICAgICAgICAgICAgICAgYXR0ciA9IGVsLmF0dHJpYnV0ZXNbaV1cbiAgICAgICAgICAgICAgICAgICAgcmVwbGFjZXIuc2V0QXR0cmlidXRlKGF0dHIubmFtZSwgYXR0ci52YWx1ZSlcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICAvLyByZXBsYWNlXG4gICAgICAgICAgICBlbCA9IHJlcGxhY2VyXG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBlbC5hcHBlbmRDaGlsZCh0ZW1wbGF0ZS5jbG9uZU5vZGUodHJ1ZSkpXG4gICAgICAgIH1cblxuICAgIH1cblxuICAgIC8vIGFwcGx5IGVsZW1lbnQgb3B0aW9uc1xuICAgIGlmIChvcHRpb25zLmlkKSBlbC5pZCA9IG9wdGlvbnMuaWRcbiAgICBpZiAob3B0aW9ucy5jbGFzc05hbWUpIGVsLmNsYXNzTmFtZSA9IG9wdGlvbnMuY2xhc3NOYW1lXG4gICAgYXR0cnMgPSBvcHRpb25zLmF0dHJpYnV0ZXNcbiAgICBpZiAoYXR0cnMpIHtcbiAgICAgICAgZm9yIChhdHRyIGluIGF0dHJzKSB7XG4gICAgICAgICAgICBlbC5zZXRBdHRyaWJ1dGUoYXR0ciwgYXR0cnNbYXR0cl0pXG4gICAgICAgIH1cbiAgICB9XG5cbiAgICByZXR1cm4gZWxcbn1cblxuLyoqXG4gKiAgRGVhbCB3aXRoIDxjb250ZW50PiBpbnNlcnRpb24gcG9pbnRzXG4gKiAgcGVyIHRoZSBXZWIgQ29tcG9uZW50cyBzcGVjXG4gKi9cbkNvbXBpbGVyUHJvdG8ucmVzb2x2ZUNvbnRlbnQgPSBmdW5jdGlvbiAoKSB7XG5cbiAgICB2YXIgb3V0bGV0cyA9IHNsaWNlLmNhbGwodGhpcy5lbC5nZXRFbGVtZW50c0J5VGFnTmFtZSgnY29udGVudCcpKSxcbiAgICAgICAgcmF3ID0gdGhpcy5yYXdDb250ZW50LFxuICAgICAgICBvdXRsZXQsIHNlbGVjdCwgaSwgaiwgbWFpblxuXG4gICAgaSA9IG91dGxldHMubGVuZ3RoXG4gICAgaWYgKGkpIHtcbiAgICAgICAgLy8gZmlyc3QgcGFzcywgY29sbGVjdCBjb3JyZXNwb25kaW5nIGNvbnRlbnRcbiAgICAgICAgLy8gZm9yIGVhY2ggb3V0bGV0LlxuICAgICAgICB3aGlsZSAoaS0tKSB7XG4gICAgICAgICAgICBvdXRsZXQgPSBvdXRsZXRzW2ldXG4gICAgICAgICAgICBpZiAocmF3KSB7XG4gICAgICAgICAgICAgICAgc2VsZWN0ID0gb3V0bGV0LmdldEF0dHJpYnV0ZSgnc2VsZWN0JylcbiAgICAgICAgICAgICAgICBpZiAoc2VsZWN0KSB7IC8vIHNlbGVjdCBjb250ZW50XG4gICAgICAgICAgICAgICAgICAgIG91dGxldC5jb250ZW50ID1cbiAgICAgICAgICAgICAgICAgICAgICAgIHNsaWNlLmNhbGwocmF3LnF1ZXJ5U2VsZWN0b3JBbGwoc2VsZWN0KSlcbiAgICAgICAgICAgICAgICB9IGVsc2UgeyAvLyBkZWZhdWx0IGNvbnRlbnRcbiAgICAgICAgICAgICAgICAgICAgbWFpbiA9IG91dGxldFxuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0gZWxzZSB7IC8vIGZhbGxiYWNrIGNvbnRlbnRcbiAgICAgICAgICAgICAgICBvdXRsZXQuY29udGVudCA9XG4gICAgICAgICAgICAgICAgICAgIHNsaWNlLmNhbGwob3V0bGV0LmNoaWxkTm9kZXMpXG4gICAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgICAgLy8gc2Vjb25kIHBhc3MsIGFjdHVhbGx5IGluc2VydCB0aGUgY29udGVudHNcbiAgICAgICAgZm9yIChpID0gMCwgaiA9IG91dGxldHMubGVuZ3RoOyBpIDwgajsgaSsrKSB7XG4gICAgICAgICAgICBvdXRsZXQgPSBvdXRsZXRzW2ldXG4gICAgICAgICAgICBpZiAob3V0bGV0ID09PSBtYWluKSBjb250aW51ZVxuICAgICAgICAgICAgaW5zZXJ0KG91dGxldCwgb3V0bGV0LmNvbnRlbnQpXG4gICAgICAgIH1cbiAgICAgICAgLy8gZmluYWxseSBpbnNlcnQgdGhlIG1haW4gY29udGVudFxuICAgICAgICBpZiAocmF3ICYmIG1haW4pIHtcbiAgICAgICAgICAgIGluc2VydChtYWluLCBzbGljZS5jYWxsKHJhdy5jaGlsZE5vZGVzKSlcbiAgICAgICAgfVxuICAgIH1cblxuICAgIGZ1bmN0aW9uIGluc2VydCAob3V0bGV0LCBjb250ZW50cykge1xuICAgICAgICB2YXIgcGFyZW50ID0gb3V0bGV0LnBhcmVudE5vZGUsXG4gICAgICAgICAgICBpID0gMCwgaiA9IGNvbnRlbnRzLmxlbmd0aFxuICAgICAgICBmb3IgKDsgaSA8IGo7IGkrKykge1xuICAgICAgICAgICAgcGFyZW50Lmluc2VydEJlZm9yZShjb250ZW50c1tpXSwgb3V0bGV0KVxuICAgICAgICB9XG4gICAgICAgIHBhcmVudC5yZW1vdmVDaGlsZChvdXRsZXQpXG4gICAgfVxuXG4gICAgdGhpcy5yYXdDb250ZW50ID0gbnVsbFxufVxuXG4vKipcbiAqICBTZXR1cCBvYnNlcnZlci5cbiAqICBUaGUgb2JzZXJ2ZXIgbGlzdGVucyBmb3IgZ2V0L3NldC9tdXRhdGUgZXZlbnRzIG9uIGFsbCBWTVxuICogIHZhbHVlcy9vYmplY3RzIGFuZCB0cmlnZ2VyIGNvcnJlc3BvbmRpbmcgYmluZGluZyB1cGRhdGVzLlxuICogIEl0IGFsc28gbGlzdGVucyBmb3IgbGlmZWN5Y2xlIGhvb2tzLlxuICovXG5Db21waWxlclByb3RvLnNldHVwT2JzZXJ2ZXIgPSBmdW5jdGlvbiAoKSB7XG5cbiAgICB2YXIgY29tcGlsZXIgPSB0aGlzLFxuICAgICAgICBiaW5kaW5ncyA9IGNvbXBpbGVyLmJpbmRpbmdzLFxuICAgICAgICBvcHRpb25zICA9IGNvbXBpbGVyLm9wdGlvbnMsXG4gICAgICAgIG9ic2VydmVyID0gY29tcGlsZXIub2JzZXJ2ZXIgPSBuZXcgRW1pdHRlcihjb21waWxlci52bSlcblxuICAgIC8vIGEgaGFzaCB0byBob2xkIGV2ZW50IHByb3hpZXMgZm9yIGVhY2ggcm9vdCBsZXZlbCBrZXlcbiAgICAvLyBzbyB0aGV5IGNhbiBiZSByZWZlcmVuY2VkIGFuZCByZW1vdmVkIGxhdGVyXG4gICAgb2JzZXJ2ZXIucHJveGllcyA9IHt9XG5cbiAgICAvLyBhZGQgb3duIGxpc3RlbmVycyB3aGljaCB0cmlnZ2VyIGJpbmRpbmcgdXBkYXRlc1xuICAgIG9ic2VydmVyXG4gICAgICAgIC5vbignZ2V0Jywgb25HZXQpXG4gICAgICAgIC5vbignc2V0Jywgb25TZXQpXG4gICAgICAgIC5vbignbXV0YXRlJywgb25TZXQpXG5cbiAgICAvLyByZWdpc3RlciBob29rc1xuICAgIHZhciBpID0gaG9va3MubGVuZ3RoLCBqLCBob29rLCBmbnNcbiAgICB3aGlsZSAoaS0tKSB7XG4gICAgICAgIGhvb2sgPSBob29rc1tpXVxuICAgICAgICBmbnMgPSBvcHRpb25zW2hvb2tdXG4gICAgICAgIGlmIChBcnJheS5pc0FycmF5KGZucykpIHtcbiAgICAgICAgICAgIGogPSBmbnMubGVuZ3RoXG4gICAgICAgICAgICAvLyBzaW5jZSBob29rcyB3ZXJlIG1lcmdlZCB3aXRoIGNoaWxkIGF0IGhlYWQsXG4gICAgICAgICAgICAvLyB3ZSBsb29wIHJldmVyc2VseS5cbiAgICAgICAgICAgIHdoaWxlIChqLS0pIHtcbiAgICAgICAgICAgICAgICByZWdpc3Rlckhvb2soaG9vaywgZm5zW2pdKVxuICAgICAgICAgICAgfVxuICAgICAgICB9IGVsc2UgaWYgKGZucykge1xuICAgICAgICAgICAgcmVnaXN0ZXJIb29rKGhvb2ssIGZucylcbiAgICAgICAgfVxuICAgIH1cblxuICAgIC8vIGJyb2FkY2FzdCBhdHRhY2hlZC9kZXRhY2hlZCBob29rc1xuICAgIG9ic2VydmVyXG4gICAgICAgIC5vbignaG9vazphdHRhY2hlZCcsIGZ1bmN0aW9uICgpIHtcbiAgICAgICAgICAgIGJyb2FkY2FzdCgxKVxuICAgICAgICB9KVxuICAgICAgICAub24oJ2hvb2s6ZGV0YWNoZWQnLCBmdW5jdGlvbiAoKSB7XG4gICAgICAgICAgICBicm9hZGNhc3QoMClcbiAgICAgICAgfSlcblxuICAgIGZ1bmN0aW9uIG9uR2V0IChrZXkpIHtcbiAgICAgICAgY2hlY2soa2V5KVxuICAgICAgICBEZXBzUGFyc2VyLmNhdGNoZXIuZW1pdCgnZ2V0JywgYmluZGluZ3Nba2V5XSlcbiAgICB9XG5cbiAgICBmdW5jdGlvbiBvblNldCAoa2V5LCB2YWwsIG11dGF0aW9uKSB7XG4gICAgICAgIG9ic2VydmVyLmVtaXQoJ2NoYW5nZTonICsga2V5LCB2YWwsIG11dGF0aW9uKVxuICAgICAgICBjaGVjayhrZXkpXG4gICAgICAgIGJpbmRpbmdzW2tleV0udXBkYXRlKHZhbClcbiAgICB9XG5cbiAgICBmdW5jdGlvbiByZWdpc3Rlckhvb2sgKGhvb2ssIGZuKSB7XG4gICAgICAgIG9ic2VydmVyLm9uKCdob29rOicgKyBob29rLCBmdW5jdGlvbiAoKSB7XG4gICAgICAgICAgICBmbi5jYWxsKGNvbXBpbGVyLnZtKVxuICAgICAgICB9KVxuICAgIH1cblxuICAgIGZ1bmN0aW9uIGJyb2FkY2FzdCAoZXZlbnQpIHtcbiAgICAgICAgdmFyIGNoaWxkcmVuID0gY29tcGlsZXIuY2hpbGRyZW5cbiAgICAgICAgaWYgKGNoaWxkcmVuKSB7XG4gICAgICAgICAgICB2YXIgY2hpbGQsIGkgPSBjaGlsZHJlbi5sZW5ndGhcbiAgICAgICAgICAgIHdoaWxlIChpLS0pIHtcbiAgICAgICAgICAgICAgICBjaGlsZCA9IGNoaWxkcmVuW2ldXG4gICAgICAgICAgICAgICAgaWYgKGNoaWxkLmVsLnBhcmVudE5vZGUpIHtcbiAgICAgICAgICAgICAgICAgICAgZXZlbnQgPSAnaG9vazonICsgKGV2ZW50ID8gJ2F0dGFjaGVkJyA6ICdkZXRhY2hlZCcpXG4gICAgICAgICAgICAgICAgICAgIGNoaWxkLm9ic2VydmVyLmVtaXQoZXZlbnQpXG4gICAgICAgICAgICAgICAgICAgIGNoaWxkLmVtaXR0ZXIuZW1pdChldmVudClcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICBmdW5jdGlvbiBjaGVjayAoa2V5KSB7XG4gICAgICAgIGlmICghYmluZGluZ3Nba2V5XSkge1xuICAgICAgICAgICAgY29tcGlsZXIuY3JlYXRlQmluZGluZyhrZXkpXG4gICAgICAgIH1cbiAgICB9XG59XG5cbkNvbXBpbGVyUHJvdG8ub2JzZXJ2ZURhdGEgPSBmdW5jdGlvbiAoZGF0YSkge1xuXG4gICAgdmFyIGNvbXBpbGVyID0gdGhpcyxcbiAgICAgICAgb2JzZXJ2ZXIgPSBjb21waWxlci5vYnNlcnZlclxuXG4gICAgLy8gcmVjdXJzaXZlbHkgb2JzZXJ2ZSBuZXN0ZWQgcHJvcGVydGllc1xuICAgIE9ic2VydmVyLm9ic2VydmUoZGF0YSwgJycsIG9ic2VydmVyKVxuXG4gICAgLy8gYWxzbyBjcmVhdGUgYmluZGluZyBmb3IgdG9wIGxldmVsICRkYXRhXG4gICAgLy8gc28gaXQgY2FuIGJlIHVzZWQgaW4gdGVtcGxhdGVzIHRvb1xuICAgIHZhciAkZGF0YUJpbmRpbmcgPSBjb21waWxlci5iaW5kaW5nc1snJGRhdGEnXSA9IG5ldyBCaW5kaW5nKGNvbXBpbGVyLCAnJGRhdGEnKVxuICAgICRkYXRhQmluZGluZy51cGRhdGUoZGF0YSlcblxuICAgIC8vIGFsbG93ICRkYXRhIHRvIGJlIHN3YXBwZWRcbiAgICBkZWYoY29tcGlsZXIudm0sICckZGF0YScsIHtcbiAgICAgICAgZ2V0OiBmdW5jdGlvbiAoKSB7XG4gICAgICAgICAgICBjb21waWxlci5vYnNlcnZlci5lbWl0KCdnZXQnLCAnJGRhdGEnKVxuICAgICAgICAgICAgcmV0dXJuIGNvbXBpbGVyLmRhdGFcbiAgICAgICAgfSxcbiAgICAgICAgc2V0OiBmdW5jdGlvbiAobmV3RGF0YSkge1xuICAgICAgICAgICAgdmFyIG9sZERhdGEgPSBjb21waWxlci5kYXRhXG4gICAgICAgICAgICBPYnNlcnZlci51bm9ic2VydmUob2xkRGF0YSwgJycsIG9ic2VydmVyKVxuICAgICAgICAgICAgY29tcGlsZXIuZGF0YSA9IG5ld0RhdGFcbiAgICAgICAgICAgIE9ic2VydmVyLmNvcHlQYXRocyhuZXdEYXRhLCBvbGREYXRhKVxuICAgICAgICAgICAgT2JzZXJ2ZXIub2JzZXJ2ZShuZXdEYXRhLCAnJywgb2JzZXJ2ZXIpXG4gICAgICAgICAgICB1cGRhdGUoKVxuICAgICAgICB9XG4gICAgfSlcblxuICAgIC8vIGVtaXQgJGRhdGEgY2hhbmdlIG9uIGFsbCBjaGFuZ2VzXG4gICAgb2JzZXJ2ZXJcbiAgICAgICAgLm9uKCdzZXQnLCBvblNldClcbiAgICAgICAgLm9uKCdtdXRhdGUnLCBvblNldClcblxuICAgIGZ1bmN0aW9uIG9uU2V0IChrZXkpIHtcbiAgICAgICAgaWYgKGtleSAhPT0gJyRkYXRhJykgdXBkYXRlKClcbiAgICB9XG5cbiAgICBmdW5jdGlvbiB1cGRhdGUgKCkge1xuICAgICAgICAkZGF0YUJpbmRpbmcudXBkYXRlKGNvbXBpbGVyLmRhdGEpXG4gICAgICAgIG9ic2VydmVyLmVtaXQoJ2NoYW5nZTokZGF0YScsIGNvbXBpbGVyLmRhdGEpXG4gICAgfVxufVxuXG4vKipcbiAqICBDb21waWxlIGEgRE9NIG5vZGUgKHJlY3Vyc2l2ZSlcbiAqL1xuQ29tcGlsZXJQcm90by5jb21waWxlID0gZnVuY3Rpb24gKG5vZGUsIHJvb3QpIHtcbiAgICB2YXIgbm9kZVR5cGUgPSBub2RlLm5vZGVUeXBlXG4gICAgaWYgKG5vZGVUeXBlID09PSAxICYmIG5vZGUudGFnTmFtZSAhPT0gJ1NDUklQVCcpIHsgLy8gYSBub3JtYWwgbm9kZVxuICAgICAgICB0aGlzLmNvbXBpbGVFbGVtZW50KG5vZGUsIHJvb3QpXG4gICAgfSBlbHNlIGlmIChub2RlVHlwZSA9PT0gMyAmJiBjb25maWcuaW50ZXJwb2xhdGUpIHtcbiAgICAgICAgdGhpcy5jb21waWxlVGV4dE5vZGUobm9kZSlcbiAgICB9XG59XG5cbi8qKlxuICogIENoZWNrIGZvciBhIHByaW9yaXR5IGRpcmVjdGl2ZVxuICogIElmIGl0IGlzIHByZXNlbnQgYW5kIHZhbGlkLCByZXR1cm4gdHJ1ZSB0byBza2lwIHRoZSByZXN0XG4gKi9cbkNvbXBpbGVyUHJvdG8uY2hlY2tQcmlvcml0eURpciA9IGZ1bmN0aW9uIChkaXJuYW1lLCBub2RlLCByb290KSB7XG4gICAgdmFyIGV4cHJlc3Npb24sIGRpcmVjdGl2ZSwgQ3RvclxuICAgIGlmIChcbiAgICAgICAgZGlybmFtZSA9PT0gJ2NvbXBvbmVudCcgJiZcbiAgICAgICAgcm9vdCAhPT0gdHJ1ZSAmJlxuICAgICAgICAoQ3RvciA9IHRoaXMucmVzb2x2ZUNvbXBvbmVudChub2RlLCB1bmRlZmluZWQsIHRydWUpKVxuICAgICkge1xuICAgICAgICBkaXJlY3RpdmUgPSB0aGlzLnBhcnNlRGlyZWN0aXZlKGRpcm5hbWUsICcnLCBub2RlKVxuICAgICAgICBkaXJlY3RpdmUuQ3RvciA9IEN0b3JcbiAgICB9IGVsc2Uge1xuICAgICAgICBleHByZXNzaW9uID0gdXRpbHMuYXR0cihub2RlLCBkaXJuYW1lKVxuICAgICAgICBkaXJlY3RpdmUgPSBleHByZXNzaW9uICYmIHRoaXMucGFyc2VEaXJlY3RpdmUoZGlybmFtZSwgZXhwcmVzc2lvbiwgbm9kZSlcbiAgICB9XG4gICAgaWYgKGRpcmVjdGl2ZSkge1xuICAgICAgICBpZiAocm9vdCA9PT0gdHJ1ZSkge1xuICAgICAgICAgICAgdXRpbHMud2FybihcbiAgICAgICAgICAgICAgICAnRGlyZWN0aXZlIHYtJyArIGRpcm5hbWUgKyAnIGNhbm5vdCBiZSB1c2VkIG9uIGFuIGFscmVhZHkgaW5zdGFudGlhdGVkICcgK1xuICAgICAgICAgICAgICAgICdWTVxcJ3Mgcm9vdCBub2RlLiBVc2UgaXQgZnJvbSB0aGUgcGFyZW50XFwncyB0ZW1wbGF0ZSBpbnN0ZWFkLidcbiAgICAgICAgICAgIClcbiAgICAgICAgICAgIHJldHVyblxuICAgICAgICB9XG4gICAgICAgIHRoaXMuZGVmZXJyZWQucHVzaChkaXJlY3RpdmUpXG4gICAgICAgIHJldHVybiB0cnVlXG4gICAgfVxufVxuXG4vKipcbiAqICBDb21waWxlIG5vcm1hbCBkaXJlY3RpdmVzIG9uIGEgbm9kZVxuICovXG5Db21waWxlclByb3RvLmNvbXBpbGVFbGVtZW50ID0gZnVuY3Rpb24gKG5vZGUsIHJvb3QpIHtcblxuICAgIC8vIHRleHRhcmVhIGlzIHByZXR0eSBhbm5veWluZ1xuICAgIC8vIGJlY2F1c2UgaXRzIHZhbHVlIGNyZWF0ZXMgY2hpbGROb2RlcyB3aGljaFxuICAgIC8vIHdlIGRvbid0IHdhbnQgdG8gY29tcGlsZS5cbiAgICBpZiAobm9kZS50YWdOYW1lID09PSAnVEVYVEFSRUEnICYmIG5vZGUudmFsdWUpIHtcbiAgICAgICAgbm9kZS52YWx1ZSA9IHRoaXMuZXZhbChub2RlLnZhbHVlKVxuICAgIH1cblxuICAgIC8vIG9ubHkgY29tcGlsZSBpZiB0aGlzIGVsZW1lbnQgaGFzIGF0dHJpYnV0ZXNcbiAgICAvLyBvciBpdHMgdGFnTmFtZSBjb250YWlucyBhIGh5cGhlbiAod2hpY2ggbWVhbnMgaXQgY291bGRcbiAgICAvLyBwb3RlbnRpYWxseSBiZSBhIGN1c3RvbSBlbGVtZW50KVxuICAgIGlmIChub2RlLmhhc0F0dHJpYnV0ZXMoKSB8fCBub2RlLnRhZ05hbWUuaW5kZXhPZignLScpID4gLTEpIHtcblxuICAgICAgICAvLyBza2lwIGFueXRoaW5nIHdpdGggdi1wcmVcbiAgICAgICAgaWYgKHV0aWxzLmF0dHIobm9kZSwgJ3ByZScpICE9PSBudWxsKSB7XG4gICAgICAgICAgICByZXR1cm5cbiAgICAgICAgfVxuXG4gICAgICAgIHZhciBpLCBsLCBqLCBrXG5cbiAgICAgICAgLy8gY2hlY2sgcHJpb3JpdHkgZGlyZWN0aXZlcy5cbiAgICAgICAgLy8gaWYgYW55IG9mIHRoZW0gYXJlIHByZXNlbnQsIGl0IHdpbGwgdGFrZSBvdmVyIHRoZSBub2RlIHdpdGggYSBjaGlsZFZNXG4gICAgICAgIC8vIHNvIHdlIGNhbiBza2lwIHRoZSByZXN0XG4gICAgICAgIGZvciAoaSA9IDAsIGwgPSBwcmlvcml0eURpcmVjdGl2ZXMubGVuZ3RoOyBpIDwgbDsgaSsrKSB7XG4gICAgICAgICAgICBpZiAodGhpcy5jaGVja1ByaW9yaXR5RGlyKHByaW9yaXR5RGlyZWN0aXZlc1tpXSwgbm9kZSwgcm9vdCkpIHtcbiAgICAgICAgICAgICAgICByZXR1cm5cbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIC8vIGNoZWNrIHRyYW5zaXRpb24gJiBhbmltYXRpb24gcHJvcGVydGllc1xuICAgICAgICBub2RlLnZ1ZV90cmFucyAgPSB1dGlscy5hdHRyKG5vZGUsICd0cmFuc2l0aW9uJylcbiAgICAgICAgbm9kZS52dWVfYW5pbSAgID0gdXRpbHMuYXR0cihub2RlLCAnYW5pbWF0aW9uJylcbiAgICAgICAgbm9kZS52dWVfZWZmZWN0ID0gdGhpcy5ldmFsKHV0aWxzLmF0dHIobm9kZSwgJ2VmZmVjdCcpKVxuXG4gICAgICAgIHZhciBwcmVmaXggPSBjb25maWcucHJlZml4ICsgJy0nLFxuICAgICAgICAgICAgYXR0cnMgPSBzbGljZS5jYWxsKG5vZGUuYXR0cmlidXRlcyksXG4gICAgICAgICAgICBwYXJhbXMgPSB0aGlzLm9wdGlvbnMucGFyYW1BdHRyaWJ1dGVzLFxuICAgICAgICAgICAgYXR0ciwgaXNEaXJlY3RpdmUsIGV4cCwgZGlyZWN0aXZlcywgZGlyZWN0aXZlLCBkaXJuYW1lXG5cbiAgICAgICAgZm9yIChpID0gMCwgbCA9IGF0dHJzLmxlbmd0aDsgaSA8IGw7IGkrKykge1xuXG4gICAgICAgICAgICBhdHRyID0gYXR0cnNbaV1cbiAgICAgICAgICAgIGlzRGlyZWN0aXZlID0gZmFsc2VcblxuICAgICAgICAgICAgaWYgKGF0dHIubmFtZS5pbmRleE9mKHByZWZpeCkgPT09IDApIHtcbiAgICAgICAgICAgICAgICAvLyBhIGRpcmVjdGl2ZSAtIHNwbGl0LCBwYXJzZSBhbmQgYmluZCBpdC5cbiAgICAgICAgICAgICAgICBpc0RpcmVjdGl2ZSA9IHRydWVcbiAgICAgICAgICAgICAgICBkaXJuYW1lID0gYXR0ci5uYW1lLnNsaWNlKHByZWZpeC5sZW5ndGgpXG4gICAgICAgICAgICAgICAgLy8gYnVpbGQgd2l0aCBtdWx0aXBsZTogdHJ1ZVxuICAgICAgICAgICAgICAgIGRpcmVjdGl2ZXMgPSB0aGlzLnBhcnNlRGlyZWN0aXZlKGRpcm5hbWUsIGF0dHIudmFsdWUsIG5vZGUsIHRydWUpXG4gICAgICAgICAgICAgICAgLy8gbG9vcCB0aHJvdWdoIGNsYXVzZXMgKHNlcGFyYXRlZCBieSBcIixcIilcbiAgICAgICAgICAgICAgICAvLyBpbnNpZGUgZWFjaCBhdHRyaWJ1dGVcbiAgICAgICAgICAgICAgICBmb3IgKGogPSAwLCBrID0gZGlyZWN0aXZlcy5sZW5ndGg7IGogPCBrOyBqKyspIHtcbiAgICAgICAgICAgICAgICAgICAgZGlyZWN0aXZlID0gZGlyZWN0aXZlc1tqXVxuICAgICAgICAgICAgICAgICAgICBpZiAoZGlybmFtZSA9PT0gJ3dpdGgnKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICB0aGlzLmJpbmREaXJlY3RpdmUoZGlyZWN0aXZlLCB0aGlzLnBhcmVudClcbiAgICAgICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRoaXMuYmluZERpcmVjdGl2ZShkaXJlY3RpdmUpXG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9IGVsc2UgaWYgKGNvbmZpZy5pbnRlcnBvbGF0ZSkge1xuICAgICAgICAgICAgICAgIC8vIG5vbiBkaXJlY3RpdmUgYXR0cmlidXRlLCBjaGVjayBpbnRlcnBvbGF0aW9uIHRhZ3NcbiAgICAgICAgICAgICAgICBleHAgPSBUZXh0UGFyc2VyLnBhcnNlQXR0cihhdHRyLnZhbHVlKVxuICAgICAgICAgICAgICAgIGlmIChleHApIHtcbiAgICAgICAgICAgICAgICAgICAgZGlyZWN0aXZlID0gdGhpcy5wYXJzZURpcmVjdGl2ZSgnYXR0cicsIGF0dHIubmFtZSArICc6JyArIGV4cCwgbm9kZSlcbiAgICAgICAgICAgICAgICAgICAgaWYgKHBhcmFtcyAmJiBwYXJhbXMuaW5kZXhPZihhdHRyLm5hbWUpID4gLTEpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIC8vIGEgcGFyYW0gYXR0cmlidXRlLi4uIHdlIHNob3VsZCB1c2UgdGhlIHBhcmVudCBiaW5kaW5nXG4gICAgICAgICAgICAgICAgICAgICAgICAvLyB0byBhdm9pZCBjaXJjdWxhciB1cGRhdGVzIGxpa2Ugc2l6ZT17e3NpemV9fVxuICAgICAgICAgICAgICAgICAgICAgICAgdGhpcy5iaW5kRGlyZWN0aXZlKGRpcmVjdGl2ZSwgdGhpcy5wYXJlbnQpXG4gICAgICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgICAgICB0aGlzLmJpbmREaXJlY3RpdmUoZGlyZWN0aXZlKVxuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBpZiAoaXNEaXJlY3RpdmUgJiYgZGlybmFtZSAhPT0gJ2Nsb2FrJykge1xuICAgICAgICAgICAgICAgIG5vZGUucmVtb3ZlQXR0cmlidXRlKGF0dHIubmFtZSlcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgfVxuXG4gICAgLy8gcmVjdXJzaXZlbHkgY29tcGlsZSBjaGlsZE5vZGVzXG4gICAgaWYgKG5vZGUuaGFzQ2hpbGROb2RlcygpKSB7XG4gICAgICAgIHNsaWNlLmNhbGwobm9kZS5jaGlsZE5vZGVzKS5mb3JFYWNoKHRoaXMuY29tcGlsZSwgdGhpcylcbiAgICB9XG59XG5cbi8qKlxuICogIENvbXBpbGUgYSB0ZXh0IG5vZGVcbiAqL1xuQ29tcGlsZXJQcm90by5jb21waWxlVGV4dE5vZGUgPSBmdW5jdGlvbiAobm9kZSkge1xuXG4gICAgdmFyIHRva2VucyA9IFRleHRQYXJzZXIucGFyc2Uobm9kZS5ub2RlVmFsdWUpXG4gICAgaWYgKCF0b2tlbnMpIHJldHVyblxuICAgIHZhciBlbCwgdG9rZW4sIGRpcmVjdGl2ZVxuXG4gICAgZm9yICh2YXIgaSA9IDAsIGwgPSB0b2tlbnMubGVuZ3RoOyBpIDwgbDsgaSsrKSB7XG5cbiAgICAgICAgdG9rZW4gPSB0b2tlbnNbaV1cbiAgICAgICAgZGlyZWN0aXZlID0gbnVsbFxuXG4gICAgICAgIGlmICh0b2tlbi5rZXkpIHsgLy8gYSBiaW5kaW5nXG4gICAgICAgICAgICBpZiAodG9rZW4ua2V5LmNoYXJBdCgwKSA9PT0gJz4nKSB7IC8vIGEgcGFydGlhbFxuICAgICAgICAgICAgICAgIGVsID0gZG9jdW1lbnQuY3JlYXRlQ29tbWVudCgncmVmJylcbiAgICAgICAgICAgICAgICBkaXJlY3RpdmUgPSB0aGlzLnBhcnNlRGlyZWN0aXZlKCdwYXJ0aWFsJywgdG9rZW4ua2V5LnNsaWNlKDEpLCBlbClcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgaWYgKCF0b2tlbi5odG1sKSB7IC8vIHRleHQgYmluZGluZ1xuICAgICAgICAgICAgICAgICAgICBlbCA9IGRvY3VtZW50LmNyZWF0ZVRleHROb2RlKCcnKVxuICAgICAgICAgICAgICAgICAgICBkaXJlY3RpdmUgPSB0aGlzLnBhcnNlRGlyZWN0aXZlKCd0ZXh0JywgdG9rZW4ua2V5LCBlbClcbiAgICAgICAgICAgICAgICB9IGVsc2UgeyAvLyBodG1sIGJpbmRpbmdcbiAgICAgICAgICAgICAgICAgICAgZWwgPSBkb2N1bWVudC5jcmVhdGVDb21tZW50KGNvbmZpZy5wcmVmaXggKyAnLWh0bWwnKVxuICAgICAgICAgICAgICAgICAgICBkaXJlY3RpdmUgPSB0aGlzLnBhcnNlRGlyZWN0aXZlKCdodG1sJywgdG9rZW4ua2V5LCBlbClcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG4gICAgICAgIH0gZWxzZSB7IC8vIGEgcGxhaW4gc3RyaW5nXG4gICAgICAgICAgICBlbCA9IGRvY3VtZW50LmNyZWF0ZVRleHROb2RlKHRva2VuKVxuICAgICAgICB9XG5cbiAgICAgICAgLy8gaW5zZXJ0IG5vZGVcbiAgICAgICAgbm9kZS5wYXJlbnROb2RlLmluc2VydEJlZm9yZShlbCwgbm9kZSlcbiAgICAgICAgLy8gYmluZCBkaXJlY3RpdmVcbiAgICAgICAgdGhpcy5iaW5kRGlyZWN0aXZlKGRpcmVjdGl2ZSlcblxuICAgIH1cbiAgICBub2RlLnBhcmVudE5vZGUucmVtb3ZlQ2hpbGQobm9kZSlcbn1cblxuLyoqXG4gKiAgUGFyc2UgYSBkaXJlY3RpdmUgbmFtZS92YWx1ZSBwYWlyIGludG8gb25lIG9yIG1vcmVcbiAqICBkaXJlY3RpdmUgaW5zdGFuY2VzXG4gKi9cbkNvbXBpbGVyUHJvdG8ucGFyc2VEaXJlY3RpdmUgPSBmdW5jdGlvbiAobmFtZSwgdmFsdWUsIGVsLCBtdWx0aXBsZSkge1xuICAgIHZhciBjb21waWxlciA9IHRoaXMsXG4gICAgICAgIGRlZmluaXRpb24gPSBjb21waWxlci5nZXRPcHRpb24oJ2RpcmVjdGl2ZXMnLCBuYW1lKVxuICAgIGlmIChkZWZpbml0aW9uKSB7XG4gICAgICAgIC8vIHBhcnNlIGludG8gQVNULWxpa2Ugb2JqZWN0c1xuICAgICAgICB2YXIgYXN0cyA9IERpcmVjdGl2ZS5wYXJzZSh2YWx1ZSlcbiAgICAgICAgcmV0dXJuIG11bHRpcGxlXG4gICAgICAgICAgICA/IGFzdHMubWFwKGJ1aWxkKVxuICAgICAgICAgICAgOiBidWlsZChhc3RzWzBdKVxuICAgIH1cbiAgICBmdW5jdGlvbiBidWlsZCAoYXN0KSB7XG4gICAgICAgIHJldHVybiBuZXcgRGlyZWN0aXZlKG5hbWUsIGFzdCwgZGVmaW5pdGlvbiwgY29tcGlsZXIsIGVsKVxuICAgIH1cbn1cblxuLyoqXG4gKiAgQWRkIGEgZGlyZWN0aXZlIGluc3RhbmNlIHRvIHRoZSBjb3JyZWN0IGJpbmRpbmcgJiB2aWV3bW9kZWxcbiAqL1xuQ29tcGlsZXJQcm90by5iaW5kRGlyZWN0aXZlID0gZnVuY3Rpb24gKGRpcmVjdGl2ZSwgYmluZGluZ093bmVyKSB7XG5cbiAgICBpZiAoIWRpcmVjdGl2ZSkgcmV0dXJuXG5cbiAgICAvLyBrZWVwIHRyYWNrIG9mIGl0IHNvIHdlIGNhbiB1bmJpbmQoKSBsYXRlclxuICAgIHRoaXMuZGlycy5wdXNoKGRpcmVjdGl2ZSlcblxuICAgIC8vIGZvciBlbXB0eSBvciBsaXRlcmFsIGRpcmVjdGl2ZXMsIHNpbXBseSBjYWxsIGl0cyBiaW5kKClcbiAgICAvLyBhbmQgd2UncmUgZG9uZS5cbiAgICBpZiAoZGlyZWN0aXZlLmlzRW1wdHkgfHwgZGlyZWN0aXZlLmlzTGl0ZXJhbCkge1xuICAgICAgICBpZiAoZGlyZWN0aXZlLmJpbmQpIGRpcmVjdGl2ZS5iaW5kKClcbiAgICAgICAgcmV0dXJuXG4gICAgfVxuXG4gICAgLy8gb3RoZXJ3aXNlLCB3ZSBnb3QgbW9yZSB3b3JrIHRvIGRvLi4uXG4gICAgdmFyIGJpbmRpbmcsXG4gICAgICAgIGNvbXBpbGVyID0gYmluZGluZ093bmVyIHx8IHRoaXMsXG4gICAgICAgIGtleSAgICAgID0gZGlyZWN0aXZlLmtleVxuXG4gICAgaWYgKGRpcmVjdGl2ZS5pc0V4cCkge1xuICAgICAgICAvLyBleHByZXNzaW9uIGJpbmRpbmdzIGFyZSBhbHdheXMgY3JlYXRlZCBvbiBjdXJyZW50IGNvbXBpbGVyXG4gICAgICAgIGJpbmRpbmcgPSBjb21waWxlci5jcmVhdGVCaW5kaW5nKGtleSwgZGlyZWN0aXZlKVxuICAgIH0gZWxzZSB7XG4gICAgICAgIC8vIHJlY3Vyc2l2ZWx5IGxvY2F0ZSB3aGljaCBjb21waWxlciBvd25zIHRoZSBiaW5kaW5nXG4gICAgICAgIHdoaWxlIChjb21waWxlcikge1xuICAgICAgICAgICAgaWYgKGNvbXBpbGVyLmhhc0tleShrZXkpKSB7XG4gICAgICAgICAgICAgICAgYnJlYWtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgY29tcGlsZXIgPSBjb21waWxlci5wYXJlbnRcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgICBjb21waWxlciA9IGNvbXBpbGVyIHx8IHRoaXNcbiAgICAgICAgYmluZGluZyA9IGNvbXBpbGVyLmJpbmRpbmdzW2tleV0gfHwgY29tcGlsZXIuY3JlYXRlQmluZGluZyhrZXkpXG4gICAgfVxuICAgIGJpbmRpbmcuZGlycy5wdXNoKGRpcmVjdGl2ZSlcbiAgICBkaXJlY3RpdmUuYmluZGluZyA9IGJpbmRpbmdcblxuICAgIHZhciB2YWx1ZSA9IGJpbmRpbmcudmFsKClcbiAgICAvLyBpbnZva2UgYmluZCBob29rIGlmIGV4aXN0c1xuICAgIGlmIChkaXJlY3RpdmUuYmluZCkge1xuICAgICAgICBkaXJlY3RpdmUuYmluZCh2YWx1ZSlcbiAgICB9XG4gICAgLy8gc2V0IGluaXRpYWwgdmFsdWVcbiAgICBkaXJlY3RpdmUudXBkYXRlKHZhbHVlLCB0cnVlKVxufVxuXG4vKipcbiAqICBDcmVhdGUgYmluZGluZyBhbmQgYXR0YWNoIGdldHRlci9zZXR0ZXIgZm9yIGEga2V5IHRvIHRoZSB2aWV3bW9kZWwgb2JqZWN0XG4gKi9cbkNvbXBpbGVyUHJvdG8uY3JlYXRlQmluZGluZyA9IGZ1bmN0aW9uIChrZXksIGRpcmVjdGl2ZSkge1xuXG4gICAgdXRpbHMubG9nKCcgIGNyZWF0ZWQgYmluZGluZzogJyArIGtleSlcblxuICAgIHZhciBjb21waWxlciA9IHRoaXMsXG4gICAgICAgIG1ldGhvZHMgID0gY29tcGlsZXIub3B0aW9ucy5tZXRob2RzLFxuICAgICAgICBpc0V4cCAgICA9IGRpcmVjdGl2ZSAmJiBkaXJlY3RpdmUuaXNFeHAsXG4gICAgICAgIGlzRm4gICAgID0gKGRpcmVjdGl2ZSAmJiBkaXJlY3RpdmUuaXNGbikgfHwgKG1ldGhvZHMgJiYgbWV0aG9kc1trZXldKSxcbiAgICAgICAgYmluZGluZ3MgPSBjb21waWxlci5iaW5kaW5ncyxcbiAgICAgICAgY29tcHV0ZWQgPSBjb21waWxlci5vcHRpb25zLmNvbXB1dGVkLFxuICAgICAgICBiaW5kaW5nICA9IG5ldyBCaW5kaW5nKGNvbXBpbGVyLCBrZXksIGlzRXhwLCBpc0ZuKVxuXG4gICAgaWYgKGlzRXhwKSB7XG4gICAgICAgIC8vIGV4cHJlc3Npb24gYmluZGluZ3MgYXJlIGFub255bW91c1xuICAgICAgICBjb21waWxlci5kZWZpbmVFeHAoa2V5LCBiaW5kaW5nLCBkaXJlY3RpdmUpXG4gICAgfSBlbHNlIGlmIChpc0ZuKSB7XG4gICAgICAgIGJpbmRpbmdzW2tleV0gPSBiaW5kaW5nXG4gICAgICAgIGJpbmRpbmcudmFsdWUgPSBjb21waWxlci52bVtrZXldID0gbWV0aG9kc1trZXldXG4gICAgfSBlbHNlIHtcbiAgICAgICAgYmluZGluZ3Nba2V5XSA9IGJpbmRpbmdcbiAgICAgICAgaWYgKGJpbmRpbmcucm9vdCkge1xuICAgICAgICAgICAgLy8gdGhpcyBpcyBhIHJvb3QgbGV2ZWwgYmluZGluZy4gd2UgbmVlZCB0byBkZWZpbmUgZ2V0dGVyL3NldHRlcnMgZm9yIGl0LlxuICAgICAgICAgICAgaWYgKGNvbXB1dGVkICYmIGNvbXB1dGVkW2tleV0pIHtcbiAgICAgICAgICAgICAgICAvLyBjb21wdXRlZCBwcm9wZXJ0eVxuICAgICAgICAgICAgICAgIGNvbXBpbGVyLmRlZmluZUNvbXB1dGVkKGtleSwgYmluZGluZywgY29tcHV0ZWRba2V5XSlcbiAgICAgICAgICAgIH0gZWxzZSBpZiAoa2V5LmNoYXJBdCgwKSAhPT0gJyQnKSB7XG4gICAgICAgICAgICAgICAgLy8gbm9ybWFsIHByb3BlcnR5XG4gICAgICAgICAgICAgICAgY29tcGlsZXIuZGVmaW5lUHJvcChrZXksIGJpbmRpbmcpXG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIGNvbXBpbGVyLmRlZmluZU1ldGEoa2V5LCBiaW5kaW5nKVxuICAgICAgICAgICAgfVxuICAgICAgICB9IGVsc2UgaWYgKGNvbXB1dGVkICYmIGNvbXB1dGVkW3V0aWxzLmJhc2VLZXkoa2V5KV0pIHtcbiAgICAgICAgICAgIC8vIG5lc3RlZCBwYXRoIG9uIGNvbXB1dGVkIHByb3BlcnR5XG4gICAgICAgICAgICBjb21waWxlci5kZWZpbmVFeHAoa2V5LCBiaW5kaW5nKVxuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgLy8gZW5zdXJlIHBhdGggaW4gZGF0YSBzbyB0aGF0IGNvbXB1dGVkIHByb3BlcnRpZXMgdGhhdFxuICAgICAgICAgICAgLy8gYWNjZXNzIHRoZSBwYXRoIGRvbid0IHRocm93IGFuIGVycm9yIGFuZCBjYW4gY29sbGVjdFxuICAgICAgICAgICAgLy8gZGVwZW5kZW5jaWVzXG4gICAgICAgICAgICBPYnNlcnZlci5lbnN1cmVQYXRoKGNvbXBpbGVyLmRhdGEsIGtleSlcbiAgICAgICAgICAgIHZhciBwYXJlbnRLZXkgPSBrZXkuc2xpY2UoMCwga2V5Lmxhc3RJbmRleE9mKCcuJykpXG4gICAgICAgICAgICBpZiAoIWJpbmRpbmdzW3BhcmVudEtleV0pIHtcbiAgICAgICAgICAgICAgICAvLyB0aGlzIGlzIGEgbmVzdGVkIHZhbHVlIGJpbmRpbmcsIGJ1dCB0aGUgYmluZGluZyBmb3IgaXRzIHBhcmVudFxuICAgICAgICAgICAgICAgIC8vIGhhcyBub3QgYmVlbiBjcmVhdGVkIHlldC4gV2UgYmV0dGVyIGNyZWF0ZSB0aGF0IG9uZSB0b28uXG4gICAgICAgICAgICAgICAgY29tcGlsZXIuY3JlYXRlQmluZGluZyhwYXJlbnRLZXkpXG4gICAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICB9XG4gICAgcmV0dXJuIGJpbmRpbmdcbn1cblxuLyoqXG4gKiAgRGVmaW5lIHRoZSBnZXR0ZXIvc2V0dGVyIGZvciBhIHJvb3QtbGV2ZWwgcHJvcGVydHkgb24gdGhlIFZNXG4gKiAgYW5kIG9ic2VydmUgdGhlIGluaXRpYWwgdmFsdWVcbiAqL1xuQ29tcGlsZXJQcm90by5kZWZpbmVQcm9wID0gZnVuY3Rpb24gKGtleSwgYmluZGluZykge1xuICAgIHZhciBjb21waWxlciA9IHRoaXMsXG4gICAgICAgIGRhdGEgICAgID0gY29tcGlsZXIuZGF0YSxcbiAgICAgICAgb2IgICAgICAgPSBkYXRhLl9fZW1pdHRlcl9fXG5cbiAgICAvLyBtYWtlIHN1cmUgdGhlIGtleSBpcyBwcmVzZW50IGluIGRhdGFcbiAgICAvLyBzbyBpdCBjYW4gYmUgb2JzZXJ2ZWRcbiAgICBpZiAoIShoYXNPd24uY2FsbChkYXRhLCBrZXkpKSkge1xuICAgICAgICBkYXRhW2tleV0gPSB1bmRlZmluZWRcbiAgICB9XG5cbiAgICAvLyBpZiB0aGUgZGF0YSBvYmplY3QgaXMgYWxyZWFkeSBvYnNlcnZlZCwgYnV0IHRoZSBrZXlcbiAgICAvLyBpcyBub3Qgb2JzZXJ2ZWQsIHdlIG5lZWQgdG8gYWRkIGl0IHRvIHRoZSBvYnNlcnZlZCBrZXlzLlxuICAgIGlmIChvYiAmJiAhKGhhc093bi5jYWxsKG9iLnZhbHVlcywga2V5KSkpIHtcbiAgICAgICAgT2JzZXJ2ZXIuY29udmVydEtleShkYXRhLCBrZXkpXG4gICAgfVxuXG4gICAgYmluZGluZy52YWx1ZSA9IGRhdGFba2V5XVxuXG4gICAgZGVmKGNvbXBpbGVyLnZtLCBrZXksIHtcbiAgICAgICAgZ2V0OiBmdW5jdGlvbiAoKSB7XG4gICAgICAgICAgICByZXR1cm4gY29tcGlsZXIuZGF0YVtrZXldXG4gICAgICAgIH0sXG4gICAgICAgIHNldDogZnVuY3Rpb24gKHZhbCkge1xuICAgICAgICAgICAgY29tcGlsZXIuZGF0YVtrZXldID0gdmFsXG4gICAgICAgIH1cbiAgICB9KVxufVxuXG4vKipcbiAqICBEZWZpbmUgYSBtZXRhIHByb3BlcnR5LCBlLmcuICRpbmRleCBvciAka2V5LFxuICogIHdoaWNoIGlzIGJpbmRhYmxlIGJ1dCBvbmx5IGFjY2Vzc2libGUgb24gdGhlIFZNLFxuICogIG5vdCBpbiB0aGUgZGF0YS5cbiAqL1xuQ29tcGlsZXJQcm90by5kZWZpbmVNZXRhID0gZnVuY3Rpb24gKGtleSwgYmluZGluZykge1xuICAgIHZhciBvYiA9IHRoaXMub2JzZXJ2ZXJcbiAgICBiaW5kaW5nLnZhbHVlID0gdGhpcy5kYXRhW2tleV1cbiAgICBkZWxldGUgdGhpcy5kYXRhW2tleV1cbiAgICBkZWYodGhpcy52bSwga2V5LCB7XG4gICAgICAgIGdldDogZnVuY3Rpb24gKCkge1xuICAgICAgICAgICAgaWYgKE9ic2VydmVyLnNob3VsZEdldCkgb2IuZW1pdCgnZ2V0Jywga2V5KVxuICAgICAgICAgICAgcmV0dXJuIGJpbmRpbmcudmFsdWVcbiAgICAgICAgfSxcbiAgICAgICAgc2V0OiBmdW5jdGlvbiAodmFsKSB7XG4gICAgICAgICAgICBvYi5lbWl0KCdzZXQnLCBrZXksIHZhbClcbiAgICAgICAgfVxuICAgIH0pXG59XG5cbi8qKlxuICogIERlZmluZSBhbiBleHByZXNzaW9uIGJpbmRpbmcsIHdoaWNoIGlzIGVzc2VudGlhbGx5XG4gKiAgYW4gYW5vbnltb3VzIGNvbXB1dGVkIHByb3BlcnR5XG4gKi9cbkNvbXBpbGVyUHJvdG8uZGVmaW5lRXhwID0gZnVuY3Rpb24gKGtleSwgYmluZGluZywgZGlyZWN0aXZlKSB7XG4gICAgdmFyIGNvbXB1dGVkS2V5ID0gZGlyZWN0aXZlICYmIGRpcmVjdGl2ZS5jb21wdXRlZEtleSxcbiAgICAgICAgZXhwICAgICAgICAgPSBjb21wdXRlZEtleSA/IGRpcmVjdGl2ZS5leHByZXNzaW9uIDoga2V5LFxuICAgICAgICBnZXR0ZXIgICAgICA9IHRoaXMuZXhwQ2FjaGVbZXhwXVxuICAgIGlmICghZ2V0dGVyKSB7XG4gICAgICAgIGdldHRlciA9IHRoaXMuZXhwQ2FjaGVbZXhwXSA9IEV4cFBhcnNlci5wYXJzZShjb21wdXRlZEtleSB8fCBrZXksIHRoaXMpXG4gICAgfVxuICAgIGlmIChnZXR0ZXIpIHtcbiAgICAgICAgdGhpcy5tYXJrQ29tcHV0ZWQoYmluZGluZywgZ2V0dGVyKVxuICAgIH1cbn1cblxuLyoqXG4gKiAgRGVmaW5lIGEgY29tcHV0ZWQgcHJvcGVydHkgb24gdGhlIFZNXG4gKi9cbkNvbXBpbGVyUHJvdG8uZGVmaW5lQ29tcHV0ZWQgPSBmdW5jdGlvbiAoa2V5LCBiaW5kaW5nLCB2YWx1ZSkge1xuICAgIHRoaXMubWFya0NvbXB1dGVkKGJpbmRpbmcsIHZhbHVlKVxuICAgIGRlZih0aGlzLnZtLCBrZXksIHtcbiAgICAgICAgZ2V0OiBiaW5kaW5nLnZhbHVlLiRnZXQsXG4gICAgICAgIHNldDogYmluZGluZy52YWx1ZS4kc2V0XG4gICAgfSlcbn1cblxuLyoqXG4gKiAgUHJvY2VzcyBhIGNvbXB1dGVkIHByb3BlcnR5IGJpbmRpbmdcbiAqICBzbyBpdHMgZ2V0dGVyL3NldHRlciBhcmUgYm91bmQgdG8gcHJvcGVyIGNvbnRleHRcbiAqL1xuQ29tcGlsZXJQcm90by5tYXJrQ29tcHV0ZWQgPSBmdW5jdGlvbiAoYmluZGluZywgdmFsdWUpIHtcbiAgICBiaW5kaW5nLmlzQ29tcHV0ZWQgPSB0cnVlXG4gICAgLy8gYmluZCB0aGUgYWNjZXNzb3JzIHRvIHRoZSB2bVxuICAgIGlmIChiaW5kaW5nLmlzRm4pIHtcbiAgICAgICAgYmluZGluZy52YWx1ZSA9IHZhbHVlXG4gICAgfSBlbHNlIHtcbiAgICAgICAgaWYgKHR5cGVvZiB2YWx1ZSA9PT0gJ2Z1bmN0aW9uJykge1xuICAgICAgICAgICAgdmFsdWUgPSB7ICRnZXQ6IHZhbHVlIH1cbiAgICAgICAgfVxuICAgICAgICBiaW5kaW5nLnZhbHVlID0ge1xuICAgICAgICAgICAgJGdldDogdXRpbHMuYmluZCh2YWx1ZS4kZ2V0LCB0aGlzLnZtKSxcbiAgICAgICAgICAgICRzZXQ6IHZhbHVlLiRzZXRcbiAgICAgICAgICAgICAgICA/IHV0aWxzLmJpbmQodmFsdWUuJHNldCwgdGhpcy52bSlcbiAgICAgICAgICAgICAgICA6IHVuZGVmaW5lZFxuICAgICAgICB9XG4gICAgfVxuICAgIC8vIGtlZXAgdHJhY2sgZm9yIGRlcCBwYXJzaW5nIGxhdGVyXG4gICAgdGhpcy5jb21wdXRlZC5wdXNoKGJpbmRpbmcpXG59XG5cbi8qKlxuICogIFJldHJpdmUgYW4gb3B0aW9uIGZyb20gdGhlIGNvbXBpbGVyXG4gKi9cbkNvbXBpbGVyUHJvdG8uZ2V0T3B0aW9uID0gZnVuY3Rpb24gKHR5cGUsIGlkLCBzaWxlbnQpIHtcbiAgICB2YXIgb3B0cyA9IHRoaXMub3B0aW9ucyxcbiAgICAgICAgcGFyZW50ID0gdGhpcy5wYXJlbnQsXG4gICAgICAgIGdsb2JhbEFzc2V0cyA9IGNvbmZpZy5nbG9iYWxBc3NldHMsXG4gICAgICAgIHJlcyA9IChvcHRzW3R5cGVdICYmIG9wdHNbdHlwZV1baWRdKSB8fCAoXG4gICAgICAgICAgICBwYXJlbnRcbiAgICAgICAgICAgICAgICA/IHBhcmVudC5nZXRPcHRpb24odHlwZSwgaWQsIHNpbGVudClcbiAgICAgICAgICAgICAgICA6IGdsb2JhbEFzc2V0c1t0eXBlXSAmJiBnbG9iYWxBc3NldHNbdHlwZV1baWRdXG4gICAgICAgIClcbiAgICBpZiAoIXJlcyAmJiAhc2lsZW50ICYmIHR5cGVvZiBpZCA9PT0gJ3N0cmluZycpIHtcbiAgICAgICAgdXRpbHMud2FybignVW5rbm93biAnICsgdHlwZS5zbGljZSgwLCAtMSkgKyAnOiAnICsgaWQpXG4gICAgfVxuICAgIHJldHVybiByZXNcbn1cblxuLyoqXG4gKiAgRW1pdCBsaWZlY3ljbGUgZXZlbnRzIHRvIHRyaWdnZXIgaG9va3NcbiAqL1xuQ29tcGlsZXJQcm90by5leGVjSG9vayA9IGZ1bmN0aW9uIChldmVudCkge1xuICAgIGV2ZW50ID0gJ2hvb2s6JyArIGV2ZW50XG4gICAgdGhpcy5vYnNlcnZlci5lbWl0KGV2ZW50KVxuICAgIHRoaXMuZW1pdHRlci5lbWl0KGV2ZW50KVxufVxuXG4vKipcbiAqICBDaGVjayBpZiBhIGNvbXBpbGVyJ3MgZGF0YSBjb250YWlucyBhIGtleXBhdGhcbiAqL1xuQ29tcGlsZXJQcm90by5oYXNLZXkgPSBmdW5jdGlvbiAoa2V5KSB7XG4gICAgdmFyIGJhc2VLZXkgPSB1dGlscy5iYXNlS2V5KGtleSlcbiAgICByZXR1cm4gaGFzT3duLmNhbGwodGhpcy5kYXRhLCBiYXNlS2V5KSB8fFxuICAgICAgICBoYXNPd24uY2FsbCh0aGlzLnZtLCBiYXNlS2V5KVxufVxuXG4vKipcbiAqICBEbyBhIG9uZS10aW1lIGV2YWwgb2YgYSBzdHJpbmcgdGhhdCBwb3RlbnRpYWxseVxuICogIGluY2x1ZGVzIGJpbmRpbmdzLiBJdCBhY2NlcHRzIGFkZGl0aW9uYWwgcmF3IGRhdGFcbiAqICBiZWNhdXNlIHdlIG5lZWQgdG8gZHluYW1pY2FsbHkgcmVzb2x2ZSB2LWNvbXBvbmVudFxuICogIGJlZm9yZSBhIGNoaWxkVk0gaXMgZXZlbiBjb21waWxlZC4uLlxuICovXG5Db21waWxlclByb3RvLmV2YWwgPSBmdW5jdGlvbiAoZXhwLCBkYXRhKSB7XG4gICAgdmFyIHBhcnNlZCA9IFRleHRQYXJzZXIucGFyc2VBdHRyKGV4cClcbiAgICByZXR1cm4gcGFyc2VkXG4gICAgICAgID8gRXhwUGFyc2VyLmV2YWwocGFyc2VkLCB0aGlzLCBkYXRhKVxuICAgICAgICA6IGV4cFxufVxuXG4vKipcbiAqICBSZXNvbHZlIGEgQ29tcG9uZW50IGNvbnN0cnVjdG9yIGZvciBhbiBlbGVtZW50XG4gKiAgd2l0aCB0aGUgZGF0YSB0byBiZSB1c2VkXG4gKi9cbkNvbXBpbGVyUHJvdG8ucmVzb2x2ZUNvbXBvbmVudCA9IGZ1bmN0aW9uIChub2RlLCBkYXRhLCB0ZXN0KSB7XG5cbiAgICAvLyBsYXRlIHJlcXVpcmUgdG8gYXZvaWQgY2lyY3VsYXIgZGVwc1xuICAgIFZpZXdNb2RlbCA9IFZpZXdNb2RlbCB8fCByZXF1aXJlKCcuL3ZpZXdtb2RlbCcpXG5cbiAgICB2YXIgZXhwICAgICA9IHV0aWxzLmF0dHIobm9kZSwgJ2NvbXBvbmVudCcpLFxuICAgICAgICB0YWdOYW1lID0gbm9kZS50YWdOYW1lLFxuICAgICAgICBpZCAgICAgID0gdGhpcy5ldmFsKGV4cCwgZGF0YSksXG4gICAgICAgIHRhZ0lkICAgPSAodGFnTmFtZS5pbmRleE9mKCctJykgPiAwICYmIHRhZ05hbWUudG9Mb3dlckNhc2UoKSksXG4gICAgICAgIEN0b3IgICAgPSB0aGlzLmdldE9wdGlvbignY29tcG9uZW50cycsIGlkIHx8IHRhZ0lkLCB0cnVlKVxuXG4gICAgaWYgKGlkICYmICFDdG9yKSB7XG4gICAgICAgIHV0aWxzLndhcm4oJ1Vua25vd24gY29tcG9uZW50OiAnICsgaWQpXG4gICAgfVxuXG4gICAgcmV0dXJuIHRlc3RcbiAgICAgICAgPyBleHAgPT09ICcnXG4gICAgICAgICAgICA/IFZpZXdNb2RlbFxuICAgICAgICAgICAgOiBDdG9yXG4gICAgICAgIDogQ3RvciB8fCBWaWV3TW9kZWxcbn1cblxuLyoqXG4gKiAgVW5iaW5kIGFuZCByZW1vdmUgZWxlbWVudFxuICovXG5Db21waWxlclByb3RvLmRlc3Ryb3kgPSBmdW5jdGlvbiAoKSB7XG5cbiAgICAvLyBhdm9pZCBiZWluZyBjYWxsZWQgbW9yZSB0aGFuIG9uY2VcbiAgICAvLyB0aGlzIGlzIGlycmV2ZXJzaWJsZSFcbiAgICBpZiAodGhpcy5kZXN0cm95ZWQpIHJldHVyblxuXG4gICAgdmFyIGNvbXBpbGVyID0gdGhpcyxcbiAgICAgICAgaSwgaiwga2V5LCBkaXIsIGRpcnMsIGJpbmRpbmcsXG4gICAgICAgIHZtICAgICAgICAgID0gY29tcGlsZXIudm0sXG4gICAgICAgIGVsICAgICAgICAgID0gY29tcGlsZXIuZWwsXG4gICAgICAgIGRpcmVjdGl2ZXMgID0gY29tcGlsZXIuZGlycyxcbiAgICAgICAgY29tcHV0ZWQgICAgPSBjb21waWxlci5jb21wdXRlZCxcbiAgICAgICAgYmluZGluZ3MgICAgPSBjb21waWxlci5iaW5kaW5ncyxcbiAgICAgICAgY2hpbGRyZW4gICAgPSBjb21waWxlci5jaGlsZHJlbixcbiAgICAgICAgcGFyZW50ICAgICAgPSBjb21waWxlci5wYXJlbnRcblxuICAgIGNvbXBpbGVyLmV4ZWNIb29rKCdiZWZvcmVEZXN0cm95JylcblxuICAgIC8vIHVub2JzZXJ2ZSBkYXRhXG4gICAgT2JzZXJ2ZXIudW5vYnNlcnZlKGNvbXBpbGVyLmRhdGEsICcnLCBjb21waWxlci5vYnNlcnZlcilcblxuICAgIC8vIHVuYmluZCBhbGwgZGlyZWNpdHZlc1xuICAgIGkgPSBkaXJlY3RpdmVzLmxlbmd0aFxuICAgIHdoaWxlIChpLS0pIHtcbiAgICAgICAgZGlyID0gZGlyZWN0aXZlc1tpXVxuICAgICAgICAvLyBpZiB0aGlzIGRpcmVjdGl2ZSBpcyBhbiBpbnN0YW5jZSBvZiBhbiBleHRlcm5hbCBiaW5kaW5nXG4gICAgICAgIC8vIGUuZy4gYSBkaXJlY3RpdmUgdGhhdCByZWZlcnMgdG8gYSB2YXJpYWJsZSBvbiB0aGUgcGFyZW50IFZNXG4gICAgICAgIC8vIHdlIG5lZWQgdG8gcmVtb3ZlIGl0IGZyb20gdGhhdCBiaW5kaW5nJ3MgZGlyZWN0aXZlc1xuICAgICAgICAvLyAqIGVtcHR5IGFuZCBsaXRlcmFsIGJpbmRpbmdzIGRvIG5vdCBoYXZlIGJpbmRpbmcuXG4gICAgICAgIGlmIChkaXIuYmluZGluZyAmJiBkaXIuYmluZGluZy5jb21waWxlciAhPT0gY29tcGlsZXIpIHtcbiAgICAgICAgICAgIGRpcnMgPSBkaXIuYmluZGluZy5kaXJzXG4gICAgICAgICAgICBpZiAoZGlycykge1xuICAgICAgICAgICAgICAgIGogPSBkaXJzLmluZGV4T2YoZGlyKVxuICAgICAgICAgICAgICAgIGlmIChqID4gLTEpIGRpcnMuc3BsaWNlKGosIDEpXG4gICAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgICAgZGlyLnVuYmluZCgpXG4gICAgfVxuXG4gICAgLy8gdW5iaW5kIGFsbCBjb21wdXRlZCwgYW5vbnltb3VzIGJpbmRpbmdzXG4gICAgaSA9IGNvbXB1dGVkLmxlbmd0aFxuICAgIHdoaWxlIChpLS0pIHtcbiAgICAgICAgY29tcHV0ZWRbaV0udW5iaW5kKClcbiAgICB9XG5cbiAgICAvLyB1bmJpbmQgYWxsIGtleXBhdGggYmluZGluZ3NcbiAgICBmb3IgKGtleSBpbiBiaW5kaW5ncykge1xuICAgICAgICBiaW5kaW5nID0gYmluZGluZ3Nba2V5XVxuICAgICAgICBpZiAoYmluZGluZykge1xuICAgICAgICAgICAgYmluZGluZy51bmJpbmQoKVxuICAgICAgICB9XG4gICAgfVxuXG4gICAgLy8gZGVzdHJveSBhbGwgY2hpbGRyZW5cbiAgICBpID0gY2hpbGRyZW4ubGVuZ3RoXG4gICAgd2hpbGUgKGktLSkge1xuICAgICAgICBjaGlsZHJlbltpXS5kZXN0cm95KClcbiAgICB9XG5cbiAgICAvLyByZW1vdmUgc2VsZiBmcm9tIHBhcmVudFxuICAgIGlmIChwYXJlbnQpIHtcbiAgICAgICAgaiA9IHBhcmVudC5jaGlsZHJlbi5pbmRleE9mKGNvbXBpbGVyKVxuICAgICAgICBpZiAoaiA+IC0xKSBwYXJlbnQuY2hpbGRyZW4uc3BsaWNlKGosIDEpXG4gICAgfVxuXG4gICAgLy8gZmluYWxseSByZW1vdmUgZG9tIGVsZW1lbnRcbiAgICBpZiAoZWwgPT09IGRvY3VtZW50LmJvZHkpIHtcbiAgICAgICAgZWwuaW5uZXJIVE1MID0gJydcbiAgICB9IGVsc2Uge1xuICAgICAgICB2bS4kcmVtb3ZlKClcbiAgICB9XG4gICAgZWwudnVlX3ZtID0gbnVsbFxuXG4gICAgY29tcGlsZXIuZGVzdHJveWVkID0gdHJ1ZVxuICAgIC8vIGVtaXQgZGVzdHJveSBob29rXG4gICAgY29tcGlsZXIuZXhlY0hvb2soJ2FmdGVyRGVzdHJveScpXG5cbiAgICAvLyBmaW5hbGx5LCB1bnJlZ2lzdGVyIGFsbCBsaXN0ZW5lcnNcbiAgICBjb21waWxlci5vYnNlcnZlci5vZmYoKVxuICAgIGNvbXBpbGVyLmVtaXR0ZXIub2ZmKClcbn1cblxuLy8gSGVscGVycyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXG4vKipcbiAqICBzaG9ydGhhbmQgZm9yIGdldHRpbmcgcm9vdCBjb21waWxlclxuICovXG5mdW5jdGlvbiBnZXRSb290IChjb21waWxlcikge1xuICAgIHdoaWxlIChjb21waWxlci5wYXJlbnQpIHtcbiAgICAgICAgY29tcGlsZXIgPSBjb21waWxlci5wYXJlbnRcbiAgICB9XG4gICAgcmV0dXJuIGNvbXBpbGVyXG59XG5cbm1vZHVsZS5leHBvcnRzID0gQ29tcGlsZXIiLCJ2YXIgVGV4dFBhcnNlciA9IHJlcXVpcmUoJy4vdGV4dC1wYXJzZXInKVxuXG5tb2R1bGUuZXhwb3J0cyA9IHtcbiAgICBwcmVmaXggICAgICAgICA6ICd2JyxcbiAgICBkZWJ1ZyAgICAgICAgICA6IGZhbHNlLFxuICAgIHNpbGVudCAgICAgICAgIDogZmFsc2UsXG4gICAgZW50ZXJDbGFzcyAgICAgOiAndi1lbnRlcicsXG4gICAgbGVhdmVDbGFzcyAgICAgOiAndi1sZWF2ZScsXG4gICAgaW50ZXJwb2xhdGUgICAgOiB0cnVlXG59XG5cbk9iamVjdC5kZWZpbmVQcm9wZXJ0eShtb2R1bGUuZXhwb3J0cywgJ2RlbGltaXRlcnMnLCB7XG4gICAgZ2V0OiBmdW5jdGlvbiAoKSB7XG4gICAgICAgIHJldHVybiBUZXh0UGFyc2VyLmRlbGltaXRlcnNcbiAgICB9LFxuICAgIHNldDogZnVuY3Rpb24gKGRlbGltaXRlcnMpIHtcbiAgICAgICAgVGV4dFBhcnNlci5zZXREZWxpbWl0ZXJzKGRlbGltaXRlcnMpXG4gICAgfVxufSkiLCJ2YXIgRW1pdHRlciAgPSByZXF1aXJlKCcuL2VtaXR0ZXInKSxcbiAgICB1dGlscyAgICA9IHJlcXVpcmUoJy4vdXRpbHMnKSxcbiAgICBPYnNlcnZlciA9IHJlcXVpcmUoJy4vb2JzZXJ2ZXInKSxcbiAgICBjYXRjaGVyICA9IG5ldyBFbWl0dGVyKClcblxuLyoqXG4gKiAgQXV0by1leHRyYWN0IHRoZSBkZXBlbmRlbmNpZXMgb2YgYSBjb21wdXRlZCBwcm9wZXJ0eVxuICogIGJ5IHJlY29yZGluZyB0aGUgZ2V0dGVycyB0cmlnZ2VyZWQgd2hlbiBldmFsdWF0aW5nIGl0LlxuICovXG5mdW5jdGlvbiBjYXRjaERlcHMgKGJpbmRpbmcpIHtcbiAgICBpZiAoYmluZGluZy5pc0ZuKSByZXR1cm5cbiAgICB1dGlscy5sb2coJ1xcbi0gJyArIGJpbmRpbmcua2V5KVxuICAgIHZhciBnb3QgPSB1dGlscy5oYXNoKClcbiAgICBiaW5kaW5nLmRlcHMgPSBbXVxuICAgIGNhdGNoZXIub24oJ2dldCcsIGZ1bmN0aW9uIChkZXApIHtcbiAgICAgICAgdmFyIGhhcyA9IGdvdFtkZXAua2V5XVxuICAgICAgICBpZiAoXG4gICAgICAgICAgICAvLyBhdm9pZCBkdXBsaWNhdGUgYmluZGluZ3NcbiAgICAgICAgICAgIChoYXMgJiYgaGFzLmNvbXBpbGVyID09PSBkZXAuY29tcGlsZXIpIHx8XG4gICAgICAgICAgICAvLyBhdm9pZCByZXBlYXRlZCBpdGVtcyBhcyBkZXBlbmRlbmN5XG4gICAgICAgICAgICAvLyBvbmx5IHdoZW4gdGhlIGJpbmRpbmcgaXMgZnJvbSBzZWxmIG9yIHRoZSBwYXJlbnQgY2hhaW5cbiAgICAgICAgICAgIChkZXAuY29tcGlsZXIucmVwZWF0ICYmICFpc1BhcmVudE9mKGRlcC5jb21waWxlciwgYmluZGluZy5jb21waWxlcikpXG4gICAgICAgICkge1xuICAgICAgICAgICAgcmV0dXJuXG4gICAgICAgIH1cbiAgICAgICAgZ290W2RlcC5rZXldID0gZGVwXG4gICAgICAgIHV0aWxzLmxvZygnICAtICcgKyBkZXAua2V5KVxuICAgICAgICBiaW5kaW5nLmRlcHMucHVzaChkZXApXG4gICAgICAgIGRlcC5zdWJzLnB1c2goYmluZGluZylcbiAgICB9KVxuICAgIGJpbmRpbmcudmFsdWUuJGdldCgpXG4gICAgY2F0Y2hlci5vZmYoJ2dldCcpXG59XG5cbi8qKlxuICogIFRlc3QgaWYgQSBpcyBhIHBhcmVudCBvZiBvciBlcXVhbHMgQlxuICovXG5mdW5jdGlvbiBpc1BhcmVudE9mIChhLCBiKSB7XG4gICAgd2hpbGUgKGIpIHtcbiAgICAgICAgaWYgKGEgPT09IGIpIHtcbiAgICAgICAgICAgIHJldHVybiB0cnVlXG4gICAgICAgIH1cbiAgICAgICAgYiA9IGIucGFyZW50XG4gICAgfVxufVxuXG5tb2R1bGUuZXhwb3J0cyA9IHtcblxuICAgIC8qKlxuICAgICAqICB0aGUgb2JzZXJ2ZXIgdGhhdCBjYXRjaGVzIGV2ZW50cyB0cmlnZ2VyZWQgYnkgZ2V0dGVyc1xuICAgICAqL1xuICAgIGNhdGNoZXI6IGNhdGNoZXIsXG5cbiAgICAvKipcbiAgICAgKiAgcGFyc2UgYSBsaXN0IG9mIGNvbXB1dGVkIHByb3BlcnR5IGJpbmRpbmdzXG4gICAgICovXG4gICAgcGFyc2U6IGZ1bmN0aW9uIChiaW5kaW5ncykge1xuICAgICAgICB1dGlscy5sb2coJ1xcbnBhcnNpbmcgZGVwZW5kZW5jaWVzLi4uJylcbiAgICAgICAgT2JzZXJ2ZXIuc2hvdWxkR2V0ID0gdHJ1ZVxuICAgICAgICBiaW5kaW5ncy5mb3JFYWNoKGNhdGNoRGVwcylcbiAgICAgICAgT2JzZXJ2ZXIuc2hvdWxkR2V0ID0gZmFsc2VcbiAgICAgICAgdXRpbHMubG9nKCdcXG5kb25lLicpXG4gICAgfVxuICAgIFxufSIsInZhciBkaXJJZCAgICAgICAgICAgPSAxLFxuICAgIEFSR19SRSAgICAgICAgICA9IC9eW1xcd1xcJC1dKyQvLFxuICAgIEZJTFRFUl9UT0tFTl9SRSA9IC9bXlxccydcIl0rfCdbXiddKyd8XCJbXlwiXStcIi9nLFxuICAgIE5FU1RJTkdfUkUgICAgICA9IC9eXFwkKHBhcmVudHxyb290KVxcLi8sXG4gICAgU0lOR0xFX1ZBUl9SRSAgID0gL15bXFx3XFwuJF0rJC8sXG4gICAgUVVPVEVfUkUgICAgICAgID0gL1wiL2dcblxuLyoqXG4gKiAgRGlyZWN0aXZlIGNsYXNzXG4gKiAgcmVwcmVzZW50cyBhIHNpbmdsZSBkaXJlY3RpdmUgaW5zdGFuY2UgaW4gdGhlIERPTVxuICovXG5mdW5jdGlvbiBEaXJlY3RpdmUgKG5hbWUsIGFzdCwgZGVmaW5pdGlvbiwgY29tcGlsZXIsIGVsKSB7XG5cbiAgICB0aGlzLmlkICAgICAgICAgICAgID0gZGlySWQrK1xuICAgIHRoaXMubmFtZSAgICAgICAgICAgPSBuYW1lXG4gICAgdGhpcy5jb21waWxlciAgICAgICA9IGNvbXBpbGVyXG4gICAgdGhpcy52bSAgICAgICAgICAgICA9IGNvbXBpbGVyLnZtXG4gICAgdGhpcy5lbCAgICAgICAgICAgICA9IGVsXG4gICAgdGhpcy5jb21wdXRlRmlsdGVycyA9IGZhbHNlXG4gICAgdGhpcy5rZXkgICAgICAgICAgICA9IGFzdC5rZXlcbiAgICB0aGlzLmFyZyAgICAgICAgICAgID0gYXN0LmFyZ1xuICAgIHRoaXMuZXhwcmVzc2lvbiAgICAgPSBhc3QuZXhwcmVzc2lvblxuXG4gICAgdmFyIGlzRW1wdHkgPSB0aGlzLmV4cHJlc3Npb24gPT09ICcnXG5cbiAgICAvLyBtaXggaW4gcHJvcGVydGllcyBmcm9tIHRoZSBkaXJlY3RpdmUgZGVmaW5pdGlvblxuICAgIGlmICh0eXBlb2YgZGVmaW5pdGlvbiA9PT0gJ2Z1bmN0aW9uJykge1xuICAgICAgICB0aGlzW2lzRW1wdHkgPyAnYmluZCcgOiAnX3VwZGF0ZSddID0gZGVmaW5pdGlvblxuICAgIH0gZWxzZSB7XG4gICAgICAgIGZvciAodmFyIHByb3AgaW4gZGVmaW5pdGlvbikge1xuICAgICAgICAgICAgaWYgKHByb3AgPT09ICd1bmJpbmQnIHx8IHByb3AgPT09ICd1cGRhdGUnKSB7XG4gICAgICAgICAgICAgICAgdGhpc1snXycgKyBwcm9wXSA9IGRlZmluaXRpb25bcHJvcF1cbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgdGhpc1twcm9wXSA9IGRlZmluaXRpb25bcHJvcF1cbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgIH1cblxuICAgIC8vIGVtcHR5IGV4cHJlc3Npb24sIHdlJ3JlIGRvbmUuXG4gICAgaWYgKGlzRW1wdHkgfHwgdGhpcy5pc0VtcHR5KSB7XG4gICAgICAgIHRoaXMuaXNFbXB0eSA9IHRydWVcbiAgICAgICAgcmV0dXJuXG4gICAgfVxuXG4gICAgdGhpcy5leHByZXNzaW9uID0gKFxuICAgICAgICB0aGlzLmlzTGl0ZXJhbFxuICAgICAgICAgICAgPyBjb21waWxlci5ldmFsKHRoaXMuZXhwcmVzc2lvbilcbiAgICAgICAgICAgIDogdGhpcy5leHByZXNzaW9uXG4gICAgKS50cmltKClcblxuICAgIHZhciBmaWx0ZXJzID0gYXN0LmZpbHRlcnMsXG4gICAgICAgIGZpbHRlciwgZm4sIGksIGwsIGNvbXB1dGVkXG4gICAgaWYgKGZpbHRlcnMpIHtcbiAgICAgICAgdGhpcy5maWx0ZXJzID0gW11cbiAgICAgICAgZm9yIChpID0gMCwgbCA9IGZpbHRlcnMubGVuZ3RoOyBpIDwgbDsgaSsrKSB7XG4gICAgICAgICAgICBmaWx0ZXIgPSBmaWx0ZXJzW2ldXG4gICAgICAgICAgICBmbiA9IHRoaXMuY29tcGlsZXIuZ2V0T3B0aW9uKCdmaWx0ZXJzJywgZmlsdGVyLm5hbWUpXG4gICAgICAgICAgICBpZiAoZm4pIHtcbiAgICAgICAgICAgICAgICBmaWx0ZXIuYXBwbHkgPSBmblxuICAgICAgICAgICAgICAgIHRoaXMuZmlsdGVycy5wdXNoKGZpbHRlcilcbiAgICAgICAgICAgICAgICBpZiAoZm4uY29tcHV0ZWQpIHtcbiAgICAgICAgICAgICAgICAgICAgY29tcHV0ZWQgPSB0cnVlXG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuICAgICAgICB9XG4gICAgfVxuXG4gICAgaWYgKCF0aGlzLmZpbHRlcnMgfHwgIXRoaXMuZmlsdGVycy5sZW5ndGgpIHtcbiAgICAgICAgdGhpcy5maWx0ZXJzID0gbnVsbFxuICAgIH1cblxuICAgIGlmIChjb21wdXRlZCkge1xuICAgICAgICB0aGlzLmNvbXB1dGVkS2V5ID0gRGlyZWN0aXZlLmlubGluZUZpbHRlcnModGhpcy5rZXksIHRoaXMuZmlsdGVycylcbiAgICAgICAgdGhpcy5maWx0ZXJzID0gbnVsbFxuICAgIH1cblxuICAgIHRoaXMuaXNFeHAgPVxuICAgICAgICBjb21wdXRlZCB8fFxuICAgICAgICAhU0lOR0xFX1ZBUl9SRS50ZXN0KHRoaXMua2V5KSB8fFxuICAgICAgICBORVNUSU5HX1JFLnRlc3QodGhpcy5rZXkpXG5cbn1cblxudmFyIERpclByb3RvID0gRGlyZWN0aXZlLnByb3RvdHlwZVxuXG4vKipcbiAqICBjYWxsZWQgd2hlbiBhIG5ldyB2YWx1ZSBpcyBzZXQgXG4gKiAgZm9yIGNvbXB1dGVkIHByb3BlcnRpZXMsIHRoaXMgd2lsbCBvbmx5IGJlIGNhbGxlZCBvbmNlXG4gKiAgZHVyaW5nIGluaXRpYWxpemF0aW9uLlxuICovXG5EaXJQcm90by51cGRhdGUgPSBmdW5jdGlvbiAodmFsdWUsIGluaXQpIHtcbiAgICBpZiAoaW5pdCB8fCB2YWx1ZSAhPT0gdGhpcy52YWx1ZSB8fCAodmFsdWUgJiYgdHlwZW9mIHZhbHVlID09PSAnb2JqZWN0JykpIHtcbiAgICAgICAgdGhpcy52YWx1ZSA9IHZhbHVlXG4gICAgICAgIGlmICh0aGlzLl91cGRhdGUpIHtcbiAgICAgICAgICAgIHRoaXMuX3VwZGF0ZShcbiAgICAgICAgICAgICAgICB0aGlzLmZpbHRlcnMgJiYgIXRoaXMuY29tcHV0ZUZpbHRlcnNcbiAgICAgICAgICAgICAgICAgICAgPyB0aGlzLmFwcGx5RmlsdGVycyh2YWx1ZSlcbiAgICAgICAgICAgICAgICAgICAgOiB2YWx1ZSxcbiAgICAgICAgICAgICAgICBpbml0XG4gICAgICAgICAgICApXG4gICAgICAgIH1cbiAgICB9XG59XG5cbi8qKlxuICogIHBpcGUgdGhlIHZhbHVlIHRocm91Z2ggZmlsdGVyc1xuICovXG5EaXJQcm90by5hcHBseUZpbHRlcnMgPSBmdW5jdGlvbiAodmFsdWUpIHtcbiAgICB2YXIgZmlsdGVyZWQgPSB2YWx1ZSwgZmlsdGVyXG4gICAgZm9yICh2YXIgaSA9IDAsIGwgPSB0aGlzLmZpbHRlcnMubGVuZ3RoOyBpIDwgbDsgaSsrKSB7XG4gICAgICAgIGZpbHRlciA9IHRoaXMuZmlsdGVyc1tpXVxuICAgICAgICBmaWx0ZXJlZCA9IGZpbHRlci5hcHBseS5hcHBseSh0aGlzLnZtLCBbZmlsdGVyZWRdLmNvbmNhdChmaWx0ZXIuYXJncykpXG4gICAgfVxuICAgIHJldHVybiBmaWx0ZXJlZFxufVxuXG4vKipcbiAqICBVbmJpbmQgZGlyZXRpdmVcbiAqL1xuRGlyUHJvdG8udW5iaW5kID0gZnVuY3Rpb24gKCkge1xuICAgIC8vIHRoaXMgY2FuIGJlIGNhbGxlZCBiZWZvcmUgdGhlIGVsIGlzIGV2ZW4gYXNzaWduZWQuLi5cbiAgICBpZiAoIXRoaXMuZWwgfHwgIXRoaXMudm0pIHJldHVyblxuICAgIGlmICh0aGlzLl91bmJpbmQpIHRoaXMuX3VuYmluZCgpXG4gICAgdGhpcy52bSA9IHRoaXMuZWwgPSB0aGlzLmJpbmRpbmcgPSB0aGlzLmNvbXBpbGVyID0gbnVsbFxufVxuXG4vLyBFeHBvc2VkIHN0YXRpYyBtZXRob2RzIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbi8qKlxuICogIFBhcnNlIGEgZGlyZWN0aXZlIHN0cmluZyBpbnRvIGFuIEFycmF5IG9mXG4gKiAgQVNULWxpa2Ugb2JqZWN0cyByZXByZXNlbnRpbmcgZGlyZWN0aXZlc1xuICovXG5EaXJlY3RpdmUucGFyc2UgPSBmdW5jdGlvbiAoc3RyKSB7XG5cbiAgICB2YXIgaW5TaW5nbGUgPSBmYWxzZSxcbiAgICAgICAgaW5Eb3VibGUgPSBmYWxzZSxcbiAgICAgICAgY3VybHkgICAgPSAwLFxuICAgICAgICBzcXVhcmUgICA9IDAsXG4gICAgICAgIHBhcmVuICAgID0gMCxcbiAgICAgICAgYmVnaW4gICAgPSAwLFxuICAgICAgICBhcmdJbmRleCA9IDAsXG4gICAgICAgIGRpcnMgICAgID0gW10sXG4gICAgICAgIGRpciAgICAgID0ge30sXG4gICAgICAgIGxhc3RGaWx0ZXJJbmRleCA9IDAsXG4gICAgICAgIGFyZ1xuXG4gICAgZm9yICh2YXIgYywgaSA9IDAsIGwgPSBzdHIubGVuZ3RoOyBpIDwgbDsgaSsrKSB7XG4gICAgICAgIGMgPSBzdHIuY2hhckF0KGkpXG4gICAgICAgIGlmIChpblNpbmdsZSkge1xuICAgICAgICAgICAgLy8gY2hlY2sgc2luZ2xlIHF1b3RlXG4gICAgICAgICAgICBpZiAoYyA9PT0gXCInXCIpIGluU2luZ2xlID0gIWluU2luZ2xlXG4gICAgICAgIH0gZWxzZSBpZiAoaW5Eb3VibGUpIHtcbiAgICAgICAgICAgIC8vIGNoZWNrIGRvdWJsZSBxdW90ZVxuICAgICAgICAgICAgaWYgKGMgPT09ICdcIicpIGluRG91YmxlID0gIWluRG91YmxlXG4gICAgICAgIH0gZWxzZSBpZiAoYyA9PT0gJywnICYmICFwYXJlbiAmJiAhY3VybHkgJiYgIXNxdWFyZSkge1xuICAgICAgICAgICAgLy8gcmVhY2hlZCB0aGUgZW5kIG9mIGEgZGlyZWN0aXZlXG4gICAgICAgICAgICBwdXNoRGlyKClcbiAgICAgICAgICAgIC8vIHJlc2V0ICYgc2tpcCB0aGUgY29tbWFcbiAgICAgICAgICAgIGRpciA9IHt9XG4gICAgICAgICAgICBiZWdpbiA9IGFyZ0luZGV4ID0gbGFzdEZpbHRlckluZGV4ID0gaSArIDFcbiAgICAgICAgfSBlbHNlIGlmIChjID09PSAnOicgJiYgIWRpci5rZXkgJiYgIWRpci5hcmcpIHtcbiAgICAgICAgICAgIC8vIGFyZ3VtZW50XG4gICAgICAgICAgICBhcmcgPSBzdHIuc2xpY2UoYmVnaW4sIGkpLnRyaW0oKVxuICAgICAgICAgICAgaWYgKEFSR19SRS50ZXN0KGFyZykpIHtcbiAgICAgICAgICAgICAgICBhcmdJbmRleCA9IGkgKyAxXG4gICAgICAgICAgICAgICAgZGlyLmFyZyA9IHN0ci5zbGljZShiZWdpbiwgaSkudHJpbSgpXG4gICAgICAgICAgICB9XG4gICAgICAgIH0gZWxzZSBpZiAoYyA9PT0gJ3wnICYmIHN0ci5jaGFyQXQoaSArIDEpICE9PSAnfCcgJiYgc3RyLmNoYXJBdChpIC0gMSkgIT09ICd8Jykge1xuICAgICAgICAgICAgaWYgKGRpci5rZXkgPT09IHVuZGVmaW5lZCkge1xuICAgICAgICAgICAgICAgIC8vIGZpcnN0IGZpbHRlciwgZW5kIG9mIGtleVxuICAgICAgICAgICAgICAgIGxhc3RGaWx0ZXJJbmRleCA9IGkgKyAxXG4gICAgICAgICAgICAgICAgZGlyLmtleSA9IHN0ci5zbGljZShhcmdJbmRleCwgaSkudHJpbSgpXG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIC8vIGFscmVhZHkgaGFzIGZpbHRlclxuICAgICAgICAgICAgICAgIHB1c2hGaWx0ZXIoKVxuICAgICAgICAgICAgfVxuICAgICAgICB9IGVsc2UgaWYgKGMgPT09ICdcIicpIHtcbiAgICAgICAgICAgIGluRG91YmxlID0gdHJ1ZVxuICAgICAgICB9IGVsc2UgaWYgKGMgPT09IFwiJ1wiKSB7XG4gICAgICAgICAgICBpblNpbmdsZSA9IHRydWVcbiAgICAgICAgfSBlbHNlIGlmIChjID09PSAnKCcpIHtcbiAgICAgICAgICAgIHBhcmVuKytcbiAgICAgICAgfSBlbHNlIGlmIChjID09PSAnKScpIHtcbiAgICAgICAgICAgIHBhcmVuLS1cbiAgICAgICAgfSBlbHNlIGlmIChjID09PSAnWycpIHtcbiAgICAgICAgICAgIHNxdWFyZSsrXG4gICAgICAgIH0gZWxzZSBpZiAoYyA9PT0gJ10nKSB7XG4gICAgICAgICAgICBzcXVhcmUtLVxuICAgICAgICB9IGVsc2UgaWYgKGMgPT09ICd7Jykge1xuICAgICAgICAgICAgY3VybHkrK1xuICAgICAgICB9IGVsc2UgaWYgKGMgPT09ICd9Jykge1xuICAgICAgICAgICAgY3VybHktLVxuICAgICAgICB9XG4gICAgfVxuICAgIGlmIChpID09PSAwIHx8IGJlZ2luICE9PSBpKSB7XG4gICAgICAgIHB1c2hEaXIoKVxuICAgIH1cblxuICAgIGZ1bmN0aW9uIHB1c2hEaXIgKCkge1xuICAgICAgICBkaXIuZXhwcmVzc2lvbiA9IHN0ci5zbGljZShiZWdpbiwgaSkudHJpbSgpXG4gICAgICAgIGlmIChkaXIua2V5ID09PSB1bmRlZmluZWQpIHtcbiAgICAgICAgICAgIGRpci5rZXkgPSBzdHIuc2xpY2UoYXJnSW5kZXgsIGkpLnRyaW0oKVxuICAgICAgICB9IGVsc2UgaWYgKGxhc3RGaWx0ZXJJbmRleCAhPT0gYmVnaW4pIHtcbiAgICAgICAgICAgIHB1c2hGaWx0ZXIoKVxuICAgICAgICB9XG4gICAgICAgIGlmIChpID09PSAwIHx8IGRpci5rZXkpIHtcbiAgICAgICAgICAgIGRpcnMucHVzaChkaXIpXG4gICAgICAgIH1cbiAgICB9XG5cbiAgICBmdW5jdGlvbiBwdXNoRmlsdGVyICgpIHtcbiAgICAgICAgdmFyIGV4cCA9IHN0ci5zbGljZShsYXN0RmlsdGVySW5kZXgsIGkpLnRyaW0oKSxcbiAgICAgICAgICAgIGZpbHRlclxuICAgICAgICBpZiAoZXhwKSB7XG4gICAgICAgICAgICBmaWx0ZXIgPSB7fVxuICAgICAgICAgICAgdmFyIHRva2VucyA9IGV4cC5tYXRjaChGSUxURVJfVE9LRU5fUkUpXG4gICAgICAgICAgICBmaWx0ZXIubmFtZSA9IHRva2Vuc1swXVxuICAgICAgICAgICAgZmlsdGVyLmFyZ3MgPSB0b2tlbnMubGVuZ3RoID4gMSA/IHRva2Vucy5zbGljZSgxKSA6IG51bGxcbiAgICAgICAgfVxuICAgICAgICBpZiAoZmlsdGVyKSB7XG4gICAgICAgICAgICAoZGlyLmZpbHRlcnMgPSBkaXIuZmlsdGVycyB8fCBbXSkucHVzaChmaWx0ZXIpXG4gICAgICAgIH1cbiAgICAgICAgbGFzdEZpbHRlckluZGV4ID0gaSArIDFcbiAgICB9XG5cbiAgICByZXR1cm4gZGlyc1xufVxuXG4vKipcbiAqICBJbmxpbmUgY29tcHV0ZWQgZmlsdGVycyBzbyB0aGV5IGJlY29tZSBwYXJ0XG4gKiAgb2YgdGhlIGV4cHJlc3Npb25cbiAqL1xuRGlyZWN0aXZlLmlubGluZUZpbHRlcnMgPSBmdW5jdGlvbiAoa2V5LCBmaWx0ZXJzKSB7XG4gICAgdmFyIGFyZ3MsIGZpbHRlclxuICAgIGZvciAodmFyIGkgPSAwLCBsID0gZmlsdGVycy5sZW5ndGg7IGkgPCBsOyBpKyspIHtcbiAgICAgICAgZmlsdGVyID0gZmlsdGVyc1tpXVxuICAgICAgICBhcmdzID0gZmlsdGVyLmFyZ3NcbiAgICAgICAgICAgID8gJyxcIicgKyBmaWx0ZXIuYXJncy5tYXAoZXNjYXBlUXVvdGUpLmpvaW4oJ1wiLFwiJykgKyAnXCInXG4gICAgICAgICAgICA6ICcnXG4gICAgICAgIGtleSA9ICd0aGlzLiRjb21waWxlci5nZXRPcHRpb24oXCJmaWx0ZXJzXCIsIFwiJyArXG4gICAgICAgICAgICAgICAgZmlsdGVyLm5hbWUgK1xuICAgICAgICAgICAgJ1wiKS5jYWxsKHRoaXMsJyArXG4gICAgICAgICAgICAgICAga2V5ICsgYXJncyArXG4gICAgICAgICAgICAnKSdcbiAgICB9XG4gICAgcmV0dXJuIGtleVxufVxuXG4vKipcbiAqICBDb252ZXJ0IGRvdWJsZSBxdW90ZXMgdG8gc2luZ2xlIHF1b3Rlc1xuICogIHNvIHRoZXkgZG9uJ3QgbWVzcyB1cCB0aGUgZ2VuZXJhdGVkIGZ1bmN0aW9uIGJvZHlcbiAqL1xuZnVuY3Rpb24gZXNjYXBlUXVvdGUgKHYpIHtcbiAgICByZXR1cm4gdi5pbmRleE9mKCdcIicpID4gLTFcbiAgICAgICAgPyB2LnJlcGxhY2UoUVVPVEVfUkUsICdcXCcnKVxuICAgICAgICA6IHZcbn1cblxubW9kdWxlLmV4cG9ydHMgPSBEaXJlY3RpdmUiLCJ2YXIgZ3VhcmQgPSByZXF1aXJlKCcuLi91dGlscycpLmd1YXJkLFxuICAgIHNsaWNlID0gW10uc2xpY2VcblxuLyoqXG4gKiAgQmluZGluZyBmb3IgaW5uZXJIVE1MXG4gKi9cbm1vZHVsZS5leHBvcnRzID0ge1xuXG4gICAgYmluZDogZnVuY3Rpb24gKCkge1xuICAgICAgICAvLyBhIGNvbW1lbnQgbm9kZSBtZWFucyB0aGlzIGlzIGEgYmluZGluZyBmb3JcbiAgICAgICAgLy8ge3t7IGlubGluZSB1bmVzY2FwZWQgaHRtbCB9fX1cbiAgICAgICAgaWYgKHRoaXMuZWwubm9kZVR5cGUgPT09IDgpIHtcbiAgICAgICAgICAgIC8vIGhvbGQgbm9kZXNcbiAgICAgICAgICAgIHRoaXMuaG9sZGVyID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnZGl2JylcbiAgICAgICAgICAgIHRoaXMubm9kZXMgPSBbXVxuICAgICAgICB9XG4gICAgfSxcblxuICAgIHVwZGF0ZTogZnVuY3Rpb24gKHZhbHVlKSB7XG4gICAgICAgIHZhbHVlID0gZ3VhcmQodmFsdWUpXG4gICAgICAgIGlmICh0aGlzLmhvbGRlcikge1xuICAgICAgICAgICAgdGhpcy5zd2FwKHZhbHVlKVxuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgdGhpcy5lbC5pbm5lckhUTUwgPSB2YWx1ZVxuICAgICAgICB9XG4gICAgfSxcblxuICAgIHN3YXA6IGZ1bmN0aW9uICh2YWx1ZSkge1xuICAgICAgICB2YXIgcGFyZW50ID0gdGhpcy5lbC5wYXJlbnROb2RlLFxuICAgICAgICAgICAgaG9sZGVyID0gdGhpcy5ob2xkZXIsXG4gICAgICAgICAgICBub2RlcyA9IHRoaXMubm9kZXMsXG4gICAgICAgICAgICBpID0gbm9kZXMubGVuZ3RoLCBsXG4gICAgICAgIHdoaWxlIChpLS0pIHtcbiAgICAgICAgICAgIHBhcmVudC5yZW1vdmVDaGlsZChub2Rlc1tpXSlcbiAgICAgICAgfVxuICAgICAgICBob2xkZXIuaW5uZXJIVE1MID0gdmFsdWVcbiAgICAgICAgbm9kZXMgPSB0aGlzLm5vZGVzID0gc2xpY2UuY2FsbChob2xkZXIuY2hpbGROb2RlcylcbiAgICAgICAgZm9yIChpID0gMCwgbCA9IG5vZGVzLmxlbmd0aDsgaSA8IGw7IGkrKykge1xuICAgICAgICAgICAgcGFyZW50Lmluc2VydEJlZm9yZShub2Rlc1tpXSwgdGhpcy5lbClcbiAgICAgICAgfVxuICAgIH1cbn0iLCJ2YXIgdXRpbHMgICAgPSByZXF1aXJlKCcuLi91dGlscycpXG5cbi8qKlxuICogIE1hbmFnZXMgYSBjb25kaXRpb25hbCBjaGlsZCBWTVxuICovXG5tb2R1bGUuZXhwb3J0cyA9IHtcblxuICAgIGJpbmQ6IGZ1bmN0aW9uICgpIHtcbiAgICAgICAgXG4gICAgICAgIHRoaXMucGFyZW50ID0gdGhpcy5lbC5wYXJlbnROb2RlXG4gICAgICAgIHRoaXMucmVmICAgID0gZG9jdW1lbnQuY3JlYXRlQ29tbWVudCgndnVlLWlmJylcbiAgICAgICAgdGhpcy5DdG9yICAgPSB0aGlzLmNvbXBpbGVyLnJlc29sdmVDb21wb25lbnQodGhpcy5lbClcblxuICAgICAgICAvLyBpbnNlcnQgcmVmXG4gICAgICAgIHRoaXMucGFyZW50Lmluc2VydEJlZm9yZSh0aGlzLnJlZiwgdGhpcy5lbClcbiAgICAgICAgdGhpcy5wYXJlbnQucmVtb3ZlQ2hpbGQodGhpcy5lbClcblxuICAgICAgICBpZiAodXRpbHMuYXR0cih0aGlzLmVsLCAndmlldycpKSB7XG4gICAgICAgICAgICB1dGlscy53YXJuKFxuICAgICAgICAgICAgICAgICdDb25mbGljdDogdi1pZiBjYW5ub3QgYmUgdXNlZCB0b2dldGhlciB3aXRoIHYtdmlldy4gJyArXG4gICAgICAgICAgICAgICAgJ0p1c3Qgc2V0IHYtdmlld1xcJ3MgYmluZGluZyB2YWx1ZSB0byBlbXB0eSBzdHJpbmcgdG8gZW1wdHkgaXQuJ1xuICAgICAgICAgICAgKVxuICAgICAgICB9XG4gICAgICAgIGlmICh1dGlscy5hdHRyKHRoaXMuZWwsICdyZXBlYXQnKSkge1xuICAgICAgICAgICAgdXRpbHMud2FybihcbiAgICAgICAgICAgICAgICAnQ29uZmxpY3Q6IHYtaWYgY2Fubm90IGJlIHVzZWQgdG9nZXRoZXIgd2l0aCB2LXJlcGVhdC4gJyArXG4gICAgICAgICAgICAgICAgJ1VzZSBgdi1zaG93YCBvciB0aGUgYGZpbHRlckJ5YCBmaWx0ZXIgaW5zdGVhZC4nXG4gICAgICAgICAgICApXG4gICAgICAgIH1cbiAgICB9LFxuXG4gICAgdXBkYXRlOiBmdW5jdGlvbiAodmFsdWUpIHtcblxuICAgICAgICBpZiAoIXZhbHVlKSB7XG4gICAgICAgICAgICB0aGlzLl91bmJpbmQoKVxuICAgICAgICB9IGVsc2UgaWYgKCF0aGlzLmNoaWxkVk0pIHtcbiAgICAgICAgICAgIHRoaXMuY2hpbGRWTSA9IG5ldyB0aGlzLkN0b3Ioe1xuICAgICAgICAgICAgICAgIGVsOiB0aGlzLmVsLmNsb25lTm9kZSh0cnVlKSxcbiAgICAgICAgICAgICAgICBwYXJlbnQ6IHRoaXMudm1cbiAgICAgICAgICAgIH0pXG4gICAgICAgICAgICBpZiAodGhpcy5jb21waWxlci5pbml0KSB7XG4gICAgICAgICAgICAgICAgdGhpcy5wYXJlbnQuaW5zZXJ0QmVmb3JlKHRoaXMuY2hpbGRWTS4kZWwsIHRoaXMucmVmKVxuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICB0aGlzLmNoaWxkVk0uJGJlZm9yZSh0aGlzLnJlZilcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgICBcbiAgICB9LFxuXG4gICAgdW5iaW5kOiBmdW5jdGlvbiAoKSB7XG4gICAgICAgIGlmICh0aGlzLmNoaWxkVk0pIHtcbiAgICAgICAgICAgIHRoaXMuY2hpbGRWTS4kZGVzdHJveSgpXG4gICAgICAgICAgICB0aGlzLmNoaWxkVk0gPSBudWxsXG4gICAgICAgIH1cbiAgICB9XG59IiwidmFyIHV0aWxzICAgICAgPSByZXF1aXJlKCcuLi91dGlscycpLFxuICAgIGNvbmZpZyAgICAgPSByZXF1aXJlKCcuLi9jb25maWcnKSxcbiAgICB0cmFuc2l0aW9uID0gcmVxdWlyZSgnLi4vdHJhbnNpdGlvbicpLFxuICAgIGRpcmVjdGl2ZXMgPSBtb2R1bGUuZXhwb3J0cyA9IHV0aWxzLmhhc2goKVxuXG4vKipcbiAqICBOZXN0IGFuZCBtYW5hZ2UgYSBDaGlsZCBWTVxuICovXG5kaXJlY3RpdmVzLmNvbXBvbmVudCA9IHtcbiAgICBpc0xpdGVyYWw6IHRydWUsXG4gICAgYmluZDogZnVuY3Rpb24gKCkge1xuICAgICAgICBpZiAoIXRoaXMuZWwudnVlX3ZtKSB7XG4gICAgICAgICAgICB0aGlzLmNoaWxkVk0gPSBuZXcgdGhpcy5DdG9yKHtcbiAgICAgICAgICAgICAgICBlbDogdGhpcy5lbCxcbiAgICAgICAgICAgICAgICBwYXJlbnQ6IHRoaXMudm1cbiAgICAgICAgICAgIH0pXG4gICAgICAgIH1cbiAgICB9LFxuICAgIHVuYmluZDogZnVuY3Rpb24gKCkge1xuICAgICAgICBpZiAodGhpcy5jaGlsZFZNKSB7XG4gICAgICAgICAgICB0aGlzLmNoaWxkVk0uJGRlc3Ryb3koKVxuICAgICAgICB9XG4gICAgfVxufVxuXG4vKipcbiAqICBCaW5kaW5nIEhUTUwgYXR0cmlidXRlc1xuICovXG5kaXJlY3RpdmVzLmF0dHIgPSB7XG4gICAgYmluZDogZnVuY3Rpb24gKCkge1xuICAgICAgICB2YXIgcGFyYW1zID0gdGhpcy52bS4kb3B0aW9ucy5wYXJhbUF0dHJpYnV0ZXNcbiAgICAgICAgdGhpcy5pc1BhcmFtID0gcGFyYW1zICYmIHBhcmFtcy5pbmRleE9mKHRoaXMuYXJnKSA+IC0xXG4gICAgfSxcbiAgICB1cGRhdGU6IGZ1bmN0aW9uICh2YWx1ZSkge1xuICAgICAgICBpZiAodmFsdWUgfHwgdmFsdWUgPT09IDApIHtcbiAgICAgICAgICAgIHRoaXMuZWwuc2V0QXR0cmlidXRlKHRoaXMuYXJnLCB2YWx1ZSlcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIHRoaXMuZWwucmVtb3ZlQXR0cmlidXRlKHRoaXMuYXJnKVxuICAgICAgICB9XG4gICAgICAgIGlmICh0aGlzLmlzUGFyYW0pIHtcbiAgICAgICAgICAgIHRoaXMudm1bdGhpcy5hcmddID0gdXRpbHMuY2hlY2tOdW1iZXIodmFsdWUpXG4gICAgICAgIH1cbiAgICB9XG59XG5cbi8qKlxuICogIEJpbmRpbmcgdGV4dENvbnRlbnRcbiAqL1xuZGlyZWN0aXZlcy50ZXh0ID0ge1xuICAgIGJpbmQ6IGZ1bmN0aW9uICgpIHtcbiAgICAgICAgdGhpcy5hdHRyID0gdGhpcy5lbC5ub2RlVHlwZSA9PT0gM1xuICAgICAgICAgICAgPyAnbm9kZVZhbHVlJ1xuICAgICAgICAgICAgOiAndGV4dENvbnRlbnQnXG4gICAgfSxcbiAgICB1cGRhdGU6IGZ1bmN0aW9uICh2YWx1ZSkge1xuICAgICAgICB0aGlzLmVsW3RoaXMuYXR0cl0gPSB1dGlscy5ndWFyZCh2YWx1ZSlcbiAgICB9XG59XG5cbi8qKlxuICogIEJpbmRpbmcgQ1NTIGRpc3BsYXkgcHJvcGVydHlcbiAqL1xuZGlyZWN0aXZlcy5zaG93ID0gZnVuY3Rpb24gKHZhbHVlKSB7XG4gICAgdmFyIGVsID0gdGhpcy5lbCxcbiAgICAgICAgdGFyZ2V0ID0gdmFsdWUgPyAnJyA6ICdub25lJyxcbiAgICAgICAgY2hhbmdlID0gZnVuY3Rpb24gKCkge1xuICAgICAgICAgICAgZWwuc3R5bGUuZGlzcGxheSA9IHRhcmdldFxuICAgICAgICB9XG4gICAgdHJhbnNpdGlvbihlbCwgdmFsdWUgPyAxIDogLTEsIGNoYW5nZSwgdGhpcy5jb21waWxlcilcbn1cblxuLyoqXG4gKiAgQmluZGluZyBDU1MgY2xhc3Nlc1xuICovXG5kaXJlY3RpdmVzWydjbGFzcyddID0gZnVuY3Rpb24gKHZhbHVlKSB7XG4gICAgaWYgKHRoaXMuYXJnKSB7XG4gICAgICAgIHV0aWxzW3ZhbHVlID8gJ2FkZENsYXNzJyA6ICdyZW1vdmVDbGFzcyddKHRoaXMuZWwsIHRoaXMuYXJnKVxuICAgIH0gZWxzZSB7XG4gICAgICAgIGlmICh0aGlzLmxhc3RWYWwpIHtcbiAgICAgICAgICAgIHV0aWxzLnJlbW92ZUNsYXNzKHRoaXMuZWwsIHRoaXMubGFzdFZhbClcbiAgICAgICAgfVxuICAgICAgICBpZiAodmFsdWUpIHtcbiAgICAgICAgICAgIHV0aWxzLmFkZENsYXNzKHRoaXMuZWwsIHZhbHVlKVxuICAgICAgICAgICAgdGhpcy5sYXN0VmFsID0gdmFsdWVcbiAgICAgICAgfVxuICAgIH1cbn1cblxuLyoqXG4gKiAgT25seSByZW1vdmVkIGFmdGVyIHRoZSBvd25lciBWTSBpcyByZWFkeVxuICovXG5kaXJlY3RpdmVzLmNsb2FrID0ge1xuICAgIGlzRW1wdHk6IHRydWUsXG4gICAgYmluZDogZnVuY3Rpb24gKCkge1xuICAgICAgICB2YXIgZWwgPSB0aGlzLmVsXG4gICAgICAgIHRoaXMuY29tcGlsZXIub2JzZXJ2ZXIub25jZSgnaG9vazpyZWFkeScsIGZ1bmN0aW9uICgpIHtcbiAgICAgICAgICAgIGVsLnJlbW92ZUF0dHJpYnV0ZShjb25maWcucHJlZml4ICsgJy1jbG9haycpXG4gICAgICAgIH0pXG4gICAgfVxufVxuXG4vKipcbiAqICBTdG9yZSBhIHJlZmVyZW5jZSB0byBzZWxmIGluIHBhcmVudCBWTSdzICRcbiAqL1xuZGlyZWN0aXZlcy5yZWYgPSB7XG4gICAgaXNMaXRlcmFsOiB0cnVlLFxuICAgIGJpbmQ6IGZ1bmN0aW9uICgpIHtcbiAgICAgICAgdmFyIGlkID0gdGhpcy5leHByZXNzaW9uXG4gICAgICAgIGlmIChpZCkge1xuICAgICAgICAgICAgdGhpcy52bS4kcGFyZW50LiRbaWRdID0gdGhpcy52bVxuICAgICAgICB9XG4gICAgfSxcbiAgICB1bmJpbmQ6IGZ1bmN0aW9uICgpIHtcbiAgICAgICAgdmFyIGlkID0gdGhpcy5leHByZXNzaW9uXG4gICAgICAgIGlmIChpZCkge1xuICAgICAgICAgICAgZGVsZXRlIHRoaXMudm0uJHBhcmVudC4kW2lkXVxuICAgICAgICB9XG4gICAgfVxufVxuXG5kaXJlY3RpdmVzLm9uICAgICAgPSByZXF1aXJlKCcuL29uJylcbmRpcmVjdGl2ZXMucmVwZWF0ICA9IHJlcXVpcmUoJy4vcmVwZWF0JylcbmRpcmVjdGl2ZXMubW9kZWwgICA9IHJlcXVpcmUoJy4vbW9kZWwnKVxuZGlyZWN0aXZlc1snaWYnXSAgID0gcmVxdWlyZSgnLi9pZicpXG5kaXJlY3RpdmVzWyd3aXRoJ10gPSByZXF1aXJlKCcuL3dpdGgnKVxuZGlyZWN0aXZlcy5odG1sICAgID0gcmVxdWlyZSgnLi9odG1sJylcbmRpcmVjdGl2ZXMuc3R5bGUgICA9IHJlcXVpcmUoJy4vc3R5bGUnKVxuZGlyZWN0aXZlcy5wYXJ0aWFsID0gcmVxdWlyZSgnLi9wYXJ0aWFsJylcbmRpcmVjdGl2ZXMudmlldyAgICA9IHJlcXVpcmUoJy4vdmlldycpIiwidmFyIHV0aWxzID0gcmVxdWlyZSgnLi4vdXRpbHMnKSxcbiAgICBpc0lFOSA9IG5hdmlnYXRvci51c2VyQWdlbnQuaW5kZXhPZignTVNJRSA5LjAnKSA+IDAsXG4gICAgZmlsdGVyID0gW10uZmlsdGVyXG5cbi8qKlxuICogIFJldHVybnMgYW4gYXJyYXkgb2YgdmFsdWVzIGZyb20gYSBtdWx0aXBsZSBzZWxlY3RcbiAqL1xuZnVuY3Rpb24gZ2V0TXVsdGlwbGVTZWxlY3RPcHRpb25zIChzZWxlY3QpIHtcbiAgICByZXR1cm4gZmlsdGVyXG4gICAgICAgIC5jYWxsKHNlbGVjdC5vcHRpb25zLCBmdW5jdGlvbiAob3B0aW9uKSB7XG4gICAgICAgICAgICByZXR1cm4gb3B0aW9uLnNlbGVjdGVkXG4gICAgICAgIH0pXG4gICAgICAgIC5tYXAoZnVuY3Rpb24gKG9wdGlvbikge1xuICAgICAgICAgICAgcmV0dXJuIG9wdGlvbi52YWx1ZSB8fCBvcHRpb24udGV4dFxuICAgICAgICB9KVxufVxuXG4vKipcbiAqICBUd28td2F5IGJpbmRpbmcgZm9yIGZvcm0gaW5wdXQgZWxlbWVudHNcbiAqL1xubW9kdWxlLmV4cG9ydHMgPSB7XG5cbiAgICBiaW5kOiBmdW5jdGlvbiAoKSB7XG5cbiAgICAgICAgdmFyIHNlbGYgPSB0aGlzLFxuICAgICAgICAgICAgZWwgICA9IHNlbGYuZWwsXG4gICAgICAgICAgICB0eXBlID0gZWwudHlwZSxcbiAgICAgICAgICAgIHRhZyAgPSBlbC50YWdOYW1lXG5cbiAgICAgICAgc2VsZi5sb2NrID0gZmFsc2VcbiAgICAgICAgc2VsZi5vd25lclZNID0gc2VsZi5iaW5kaW5nLmNvbXBpbGVyLnZtXG5cbiAgICAgICAgLy8gZGV0ZXJtaW5lIHdoYXQgZXZlbnQgdG8gbGlzdGVuIHRvXG4gICAgICAgIHNlbGYuZXZlbnQgPVxuICAgICAgICAgICAgKHNlbGYuY29tcGlsZXIub3B0aW9ucy5sYXp5IHx8XG4gICAgICAgICAgICB0YWcgPT09ICdTRUxFQ1QnIHx8XG4gICAgICAgICAgICB0eXBlID09PSAnY2hlY2tib3gnIHx8IHR5cGUgPT09ICdyYWRpbycpXG4gICAgICAgICAgICAgICAgPyAnY2hhbmdlJ1xuICAgICAgICAgICAgICAgIDogJ2lucHV0J1xuXG4gICAgICAgIC8vIGRldGVybWluZSB0aGUgYXR0cmlidXRlIHRvIGNoYW5nZSB3aGVuIHVwZGF0aW5nXG4gICAgICAgIHNlbGYuYXR0ciA9IHR5cGUgPT09ICdjaGVja2JveCdcbiAgICAgICAgICAgID8gJ2NoZWNrZWQnXG4gICAgICAgICAgICA6ICh0YWcgPT09ICdJTlBVVCcgfHwgdGFnID09PSAnU0VMRUNUJyB8fCB0YWcgPT09ICdURVhUQVJFQScpXG4gICAgICAgICAgICAgICAgPyAndmFsdWUnXG4gICAgICAgICAgICAgICAgOiAnaW5uZXJIVE1MJ1xuXG4gICAgICAgIC8vIHNlbGVjdFttdWx0aXBsZV0gc3VwcG9ydFxuICAgICAgICBpZih0YWcgPT09ICdTRUxFQ1QnICYmIGVsLmhhc0F0dHJpYnV0ZSgnbXVsdGlwbGUnKSkge1xuICAgICAgICAgICAgdGhpcy5tdWx0aSA9IHRydWVcbiAgICAgICAgfVxuXG4gICAgICAgIHZhciBjb21wb3NpdGlvbkxvY2sgPSBmYWxzZVxuICAgICAgICBzZWxmLmNMb2NrID0gZnVuY3Rpb24gKCkge1xuICAgICAgICAgICAgY29tcG9zaXRpb25Mb2NrID0gdHJ1ZVxuICAgICAgICB9XG4gICAgICAgIHNlbGYuY1VubG9jayA9IGZ1bmN0aW9uICgpIHtcbiAgICAgICAgICAgIGNvbXBvc2l0aW9uTG9jayA9IGZhbHNlXG4gICAgICAgIH1cbiAgICAgICAgZWwuYWRkRXZlbnRMaXN0ZW5lcignY29tcG9zaXRpb25zdGFydCcsIHRoaXMuY0xvY2spXG4gICAgICAgIGVsLmFkZEV2ZW50TGlzdGVuZXIoJ2NvbXBvc2l0aW9uZW5kJywgdGhpcy5jVW5sb2NrKVxuXG4gICAgICAgIC8vIGF0dGFjaCBsaXN0ZW5lclxuICAgICAgICBzZWxmLnNldCA9IHNlbGYuZmlsdGVyc1xuICAgICAgICAgICAgPyBmdW5jdGlvbiAoKSB7XG4gICAgICAgICAgICAgICAgaWYgKGNvbXBvc2l0aW9uTG9jaykgcmV0dXJuXG4gICAgICAgICAgICAgICAgLy8gaWYgdGhpcyBkaXJlY3RpdmUgaGFzIGZpbHRlcnNcbiAgICAgICAgICAgICAgICAvLyB3ZSBuZWVkIHRvIGxldCB0aGUgdm0uJHNldCB0cmlnZ2VyXG4gICAgICAgICAgICAgICAgLy8gdXBkYXRlKCkgc28gZmlsdGVycyBhcmUgYXBwbGllZC5cbiAgICAgICAgICAgICAgICAvLyB0aGVyZWZvcmUgd2UgaGF2ZSB0byByZWNvcmQgY3Vyc29yIHBvc2l0aW9uXG4gICAgICAgICAgICAgICAgLy8gc28gdGhhdCBhZnRlciB2bS4kc2V0IGNoYW5nZXMgdGhlIGlucHV0XG4gICAgICAgICAgICAgICAgLy8gdmFsdWUgd2UgY2FuIHB1dCB0aGUgY3Vyc29yIGJhY2sgYXQgd2hlcmUgaXQgaXNcbiAgICAgICAgICAgICAgICB2YXIgY3Vyc29yUG9zXG4gICAgICAgICAgICAgICAgdHJ5IHsgY3Vyc29yUG9zID0gZWwuc2VsZWN0aW9uU3RhcnQgfSBjYXRjaCAoZSkge31cblxuICAgICAgICAgICAgICAgIHNlbGYuX3NldCgpXG5cbiAgICAgICAgICAgICAgICAvLyBzaW5jZSB1cGRhdGVzIGFyZSBhc3luY1xuICAgICAgICAgICAgICAgIC8vIHdlIG5lZWQgdG8gcmVzZXQgY3Vyc29yIHBvc2l0aW9uIGFzeW5jIHRvb1xuICAgICAgICAgICAgICAgIHV0aWxzLm5leHRUaWNrKGZ1bmN0aW9uICgpIHtcbiAgICAgICAgICAgICAgICAgICAgaWYgKGN1cnNvclBvcyAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBlbC5zZXRTZWxlY3Rpb25SYW5nZShjdXJzb3JQb3MsIGN1cnNvclBvcylcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH0pXG4gICAgICAgICAgICB9XG4gICAgICAgICAgICA6IGZ1bmN0aW9uICgpIHtcbiAgICAgICAgICAgICAgICBpZiAoY29tcG9zaXRpb25Mb2NrKSByZXR1cm5cbiAgICAgICAgICAgICAgICAvLyBubyBmaWx0ZXJzLCBkb24ndCBsZXQgaXQgdHJpZ2dlciB1cGRhdGUoKVxuICAgICAgICAgICAgICAgIHNlbGYubG9jayA9IHRydWVcblxuICAgICAgICAgICAgICAgIHNlbGYuX3NldCgpXG5cbiAgICAgICAgICAgICAgICB1dGlscy5uZXh0VGljayhmdW5jdGlvbiAoKSB7XG4gICAgICAgICAgICAgICAgICAgIHNlbGYubG9jayA9IGZhbHNlXG4gICAgICAgICAgICAgICAgfSlcbiAgICAgICAgICAgIH1cbiAgICAgICAgZWwuYWRkRXZlbnRMaXN0ZW5lcihzZWxmLmV2ZW50LCBzZWxmLnNldClcblxuICAgICAgICAvLyBmaXggc2hpdCBmb3IgSUU5XG4gICAgICAgIC8vIHNpbmNlIGl0IGRvZXNuJ3QgZmlyZSBpbnB1dCBvbiBiYWNrc3BhY2UgLyBkZWwgLyBjdXRcbiAgICAgICAgaWYgKGlzSUU5KSB7XG4gICAgICAgICAgICBzZWxmLm9uQ3V0ID0gZnVuY3Rpb24gKCkge1xuICAgICAgICAgICAgICAgIC8vIGN1dCBldmVudCBmaXJlcyBiZWZvcmUgdGhlIHZhbHVlIGFjdHVhbGx5IGNoYW5nZXNcbiAgICAgICAgICAgICAgICB1dGlscy5uZXh0VGljayhmdW5jdGlvbiAoKSB7XG4gICAgICAgICAgICAgICAgICAgIHNlbGYuc2V0KClcbiAgICAgICAgICAgICAgICB9KVxuICAgICAgICAgICAgfVxuICAgICAgICAgICAgc2VsZi5vbkRlbCA9IGZ1bmN0aW9uIChlKSB7XG4gICAgICAgICAgICAgICAgaWYgKGUua2V5Q29kZSA9PT0gNDYgfHwgZS5rZXlDb2RlID09PSA4KSB7XG4gICAgICAgICAgICAgICAgICAgIHNlbGYuc2V0KClcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBlbC5hZGRFdmVudExpc3RlbmVyKCdjdXQnLCBzZWxmLm9uQ3V0KVxuICAgICAgICAgICAgZWwuYWRkRXZlbnRMaXN0ZW5lcigna2V5dXAnLCBzZWxmLm9uRGVsKVxuICAgICAgICB9XG4gICAgfSxcblxuICAgIF9zZXQ6IGZ1bmN0aW9uICgpIHtcbiAgICAgICAgdGhpcy5vd25lclZNLiRzZXQoXG4gICAgICAgICAgICB0aGlzLmtleSwgdGhpcy5tdWx0aVxuICAgICAgICAgICAgICAgID8gZ2V0TXVsdGlwbGVTZWxlY3RPcHRpb25zKHRoaXMuZWwpXG4gICAgICAgICAgICAgICAgOiB0aGlzLmVsW3RoaXMuYXR0cl1cbiAgICAgICAgKVxuICAgIH0sXG5cbiAgICB1cGRhdGU6IGZ1bmN0aW9uICh2YWx1ZSwgaW5pdCkge1xuICAgICAgICAvKiBqc2hpbnQgZXFlcWVxOiBmYWxzZSAqL1xuICAgICAgICAvLyBzeW5jIGJhY2sgaW5saW5lIHZhbHVlIGlmIGluaXRpYWwgZGF0YSBpcyB1bmRlZmluZWRcbiAgICAgICAgaWYgKGluaXQgJiYgdmFsdWUgPT09IHVuZGVmaW5lZCkge1xuICAgICAgICAgICAgcmV0dXJuIHRoaXMuX3NldCgpXG4gICAgICAgIH1cbiAgICAgICAgaWYgKHRoaXMubG9jaykgcmV0dXJuXG4gICAgICAgIHZhciBlbCA9IHRoaXMuZWxcbiAgICAgICAgaWYgKGVsLnRhZ05hbWUgPT09ICdTRUxFQ1QnKSB7IC8vIHNlbGVjdCBkcm9wZG93blxuICAgICAgICAgICAgZWwuc2VsZWN0ZWRJbmRleCA9IC0xXG4gICAgICAgICAgICBpZih0aGlzLm11bHRpICYmIEFycmF5LmlzQXJyYXkodmFsdWUpKSB7XG4gICAgICAgICAgICAgICAgdmFsdWUuZm9yRWFjaCh0aGlzLnVwZGF0ZVNlbGVjdCwgdGhpcylcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgdGhpcy51cGRhdGVTZWxlY3QodmFsdWUpXG4gICAgICAgICAgICB9XG4gICAgICAgIH0gZWxzZSBpZiAoZWwudHlwZSA9PT0gJ3JhZGlvJykgeyAvLyByYWRpbyBidXR0b25cbiAgICAgICAgICAgIGVsLmNoZWNrZWQgPSB2YWx1ZSA9PSBlbC52YWx1ZVxuICAgICAgICB9IGVsc2UgaWYgKGVsLnR5cGUgPT09ICdjaGVja2JveCcpIHsgLy8gY2hlY2tib3hcbiAgICAgICAgICAgIGVsLmNoZWNrZWQgPSAhIXZhbHVlXG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBlbFt0aGlzLmF0dHJdID0gdXRpbHMuZ3VhcmQodmFsdWUpXG4gICAgICAgIH1cbiAgICB9LFxuXG4gICAgdXBkYXRlU2VsZWN0OiBmdW5jdGlvbiAodmFsdWUpIHtcbiAgICAgICAgLyoganNoaW50IGVxZXFlcTogZmFsc2UgKi9cbiAgICAgICAgLy8gc2V0dGluZyA8c2VsZWN0PidzIHZhbHVlIGluIElFOSBkb2Vzbid0IHdvcmtcbiAgICAgICAgLy8gd2UgaGF2ZSB0byBtYW51YWxseSBsb29wIHRocm91Z2ggdGhlIG9wdGlvbnNcbiAgICAgICAgdmFyIG9wdGlvbnMgPSB0aGlzLmVsLm9wdGlvbnMsXG4gICAgICAgICAgICBpID0gb3B0aW9ucy5sZW5ndGhcbiAgICAgICAgd2hpbGUgKGktLSkge1xuICAgICAgICAgICAgaWYgKG9wdGlvbnNbaV0udmFsdWUgPT0gdmFsdWUpIHtcbiAgICAgICAgICAgICAgICBvcHRpb25zW2ldLnNlbGVjdGVkID0gdHJ1ZVxuICAgICAgICAgICAgICAgIGJyZWFrXG4gICAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICB9LFxuXG4gICAgdW5iaW5kOiBmdW5jdGlvbiAoKSB7XG4gICAgICAgIHZhciBlbCA9IHRoaXMuZWxcbiAgICAgICAgZWwucmVtb3ZlRXZlbnRMaXN0ZW5lcih0aGlzLmV2ZW50LCB0aGlzLnNldClcbiAgICAgICAgZWwucmVtb3ZlRXZlbnRMaXN0ZW5lcignY29tcG9zaXRpb25zdGFydCcsIHRoaXMuY0xvY2spXG4gICAgICAgIGVsLnJlbW92ZUV2ZW50TGlzdGVuZXIoJ2NvbXBvc2l0aW9uZW5kJywgdGhpcy5jVW5sb2NrKVxuICAgICAgICBpZiAoaXNJRTkpIHtcbiAgICAgICAgICAgIGVsLnJlbW92ZUV2ZW50TGlzdGVuZXIoJ2N1dCcsIHRoaXMub25DdXQpXG4gICAgICAgICAgICBlbC5yZW1vdmVFdmVudExpc3RlbmVyKCdrZXl1cCcsIHRoaXMub25EZWwpXG4gICAgICAgIH1cbiAgICB9XG59IiwidmFyIHV0aWxzICAgID0gcmVxdWlyZSgnLi4vdXRpbHMnKVxuXG4vKipcbiAqICBCaW5kaW5nIGZvciBldmVudCBsaXN0ZW5lcnNcbiAqL1xubW9kdWxlLmV4cG9ydHMgPSB7XG5cbiAgICBpc0ZuOiB0cnVlLFxuXG4gICAgYmluZDogZnVuY3Rpb24gKCkge1xuICAgICAgICB0aGlzLmNvbnRleHQgPSB0aGlzLmJpbmRpbmcuaXNFeHBcbiAgICAgICAgICAgID8gdGhpcy52bVxuICAgICAgICAgICAgOiB0aGlzLmJpbmRpbmcuY29tcGlsZXIudm1cbiAgICB9LFxuXG4gICAgdXBkYXRlOiBmdW5jdGlvbiAoaGFuZGxlcikge1xuICAgICAgICBpZiAodHlwZW9mIGhhbmRsZXIgIT09ICdmdW5jdGlvbicpIHtcbiAgICAgICAgICAgIHV0aWxzLndhcm4oJ0RpcmVjdGl2ZSBcInYtb246JyArIHRoaXMuZXhwcmVzc2lvbiArICdcIiBleHBlY3RzIGEgbWV0aG9kLicpXG4gICAgICAgICAgICByZXR1cm5cbiAgICAgICAgfVxuICAgICAgICB0aGlzLl91bmJpbmQoKVxuICAgICAgICB2YXIgdm0gPSB0aGlzLnZtLFxuICAgICAgICAgICAgY29udGV4dCA9IHRoaXMuY29udGV4dFxuICAgICAgICB0aGlzLmhhbmRsZXIgPSBmdW5jdGlvbiAoZSkge1xuICAgICAgICAgICAgZS50YXJnZXRWTSA9IHZtXG4gICAgICAgICAgICBjb250ZXh0LiRldmVudCA9IGVcbiAgICAgICAgICAgIHZhciByZXMgPSBoYW5kbGVyLmNhbGwoY29udGV4dCwgZSlcbiAgICAgICAgICAgIGNvbnRleHQuJGV2ZW50ID0gbnVsbFxuICAgICAgICAgICAgcmV0dXJuIHJlc1xuICAgICAgICB9XG4gICAgICAgIHRoaXMuZWwuYWRkRXZlbnRMaXN0ZW5lcih0aGlzLmFyZywgdGhpcy5oYW5kbGVyKVxuICAgIH0sXG5cbiAgICB1bmJpbmQ6IGZ1bmN0aW9uICgpIHtcbiAgICAgICAgdGhpcy5lbC5yZW1vdmVFdmVudExpc3RlbmVyKHRoaXMuYXJnLCB0aGlzLmhhbmRsZXIpXG4gICAgfVxufSIsInZhciB1dGlscyA9IHJlcXVpcmUoJy4uL3V0aWxzJylcblxuLyoqXG4gKiAgQmluZGluZyBmb3IgcGFydGlhbHNcbiAqL1xubW9kdWxlLmV4cG9ydHMgPSB7XG5cbiAgICBpc0xpdGVyYWw6IHRydWUsXG5cbiAgICBiaW5kOiBmdW5jdGlvbiAoKSB7XG5cbiAgICAgICAgdmFyIGlkID0gdGhpcy5leHByZXNzaW9uXG4gICAgICAgIGlmICghaWQpIHJldHVyblxuXG4gICAgICAgIHZhciBlbCAgICAgICA9IHRoaXMuZWwsXG4gICAgICAgICAgICBjb21waWxlciA9IHRoaXMuY29tcGlsZXIsXG4gICAgICAgICAgICBwYXJ0aWFsICA9IGNvbXBpbGVyLmdldE9wdGlvbigncGFydGlhbHMnLCBpZClcblxuICAgICAgICBpZiAoIXBhcnRpYWwpIHtcbiAgICAgICAgICAgIGlmIChpZCA9PT0gJ3lpZWxkJykge1xuICAgICAgICAgICAgICAgIHV0aWxzLndhcm4oJ3t7PnlpZWxkfX0gc3ludGF4IGhhcyBiZWVuIGRlcHJlY2F0ZWQuIFVzZSA8Y29udGVudD4gdGFnIGluc3RlYWQuJylcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHJldHVyblxuICAgICAgICB9XG5cbiAgICAgICAgcGFydGlhbCA9IHBhcnRpYWwuY2xvbmVOb2RlKHRydWUpXG5cbiAgICAgICAgLy8gY29tbWVudCByZWYgbm9kZSBtZWFucyBpbmxpbmUgcGFydGlhbFxuICAgICAgICBpZiAoZWwubm9kZVR5cGUgPT09IDgpIHtcblxuICAgICAgICAgICAgLy8ga2VlcCBhIHJlZiBmb3IgdGhlIHBhcnRpYWwncyBjb250ZW50IG5vZGVzXG4gICAgICAgICAgICB2YXIgbm9kZXMgPSBbXS5zbGljZS5jYWxsKHBhcnRpYWwuY2hpbGROb2RlcyksXG4gICAgICAgICAgICAgICAgcGFyZW50ID0gZWwucGFyZW50Tm9kZVxuICAgICAgICAgICAgcGFyZW50Lmluc2VydEJlZm9yZShwYXJ0aWFsLCBlbClcbiAgICAgICAgICAgIHBhcmVudC5yZW1vdmVDaGlsZChlbClcbiAgICAgICAgICAgIC8vIGNvbXBpbGUgcGFydGlhbCBhZnRlciBhcHBlbmRpbmcsIGJlY2F1c2UgaXRzIGNoaWxkcmVuJ3MgcGFyZW50Tm9kZVxuICAgICAgICAgICAgLy8gd2lsbCBjaGFuZ2UgZnJvbSB0aGUgZnJhZ21lbnQgdG8gdGhlIGNvcnJlY3QgcGFyZW50Tm9kZS5cbiAgICAgICAgICAgIC8vIFRoaXMgY291bGQgYWZmZWN0IGRpcmVjdGl2ZXMgdGhhdCBuZWVkIGFjY2VzcyB0byBpdHMgZWxlbWVudCdzIHBhcmVudE5vZGUuXG4gICAgICAgICAgICBub2Rlcy5mb3JFYWNoKGNvbXBpbGVyLmNvbXBpbGUsIGNvbXBpbGVyKVxuXG4gICAgICAgIH0gZWxzZSB7XG5cbiAgICAgICAgICAgIC8vIGp1c3Qgc2V0IGlubmVySFRNTC4uLlxuICAgICAgICAgICAgZWwuaW5uZXJIVE1MID0gJydcbiAgICAgICAgICAgIGVsLmFwcGVuZENoaWxkKHBhcnRpYWwuY2xvbmVOb2RlKHRydWUpKVxuXG4gICAgICAgIH1cbiAgICB9XG5cbn0iLCJ2YXIgdXRpbHMgICAgICA9IHJlcXVpcmUoJy4uL3V0aWxzJyksXG4gICAgY29uZmlnICAgICA9IHJlcXVpcmUoJy4uL2NvbmZpZycpXG5cbi8qKlxuICogIEJpbmRpbmcgdGhhdCBtYW5hZ2VzIFZNcyBiYXNlZCBvbiBhbiBBcnJheVxuICovXG5tb2R1bGUuZXhwb3J0cyA9IHtcblxuICAgIGJpbmQ6IGZ1bmN0aW9uICgpIHtcblxuICAgICAgICB0aGlzLmlkZW50aWZpZXIgPSAnJHInICsgdGhpcy5pZFxuXG4gICAgICAgIC8vIGEgaGFzaCB0byBjYWNoZSB0aGUgc2FtZSBleHByZXNzaW9ucyBvbiByZXBlYXRlZCBpbnN0YW5jZXNcbiAgICAgICAgLy8gc28gdGhleSBkb24ndCBoYXZlIHRvIGJlIGNvbXBpbGVkIGZvciBldmVyeSBzaW5nbGUgaW5zdGFuY2VcbiAgICAgICAgdGhpcy5leHBDYWNoZSA9IHV0aWxzLmhhc2goKVxuXG4gICAgICAgIHZhciBlbCAgID0gdGhpcy5lbCxcbiAgICAgICAgICAgIGN0biAgPSB0aGlzLmNvbnRhaW5lciA9IGVsLnBhcmVudE5vZGVcblxuICAgICAgICAvLyBleHRyYWN0IGNoaWxkIElkLCBpZiBhbnlcbiAgICAgICAgdGhpcy5jaGlsZElkID0gdGhpcy5jb21waWxlci5ldmFsKHV0aWxzLmF0dHIoZWwsICdyZWYnKSlcblxuICAgICAgICAvLyBjcmVhdGUgYSBjb21tZW50IG5vZGUgYXMgYSByZWZlcmVuY2Ugbm9kZSBmb3IgRE9NIGluc2VydGlvbnNcbiAgICAgICAgdGhpcy5yZWYgPSBkb2N1bWVudC5jcmVhdGVDb21tZW50KGNvbmZpZy5wcmVmaXggKyAnLXJlcGVhdC0nICsgdGhpcy5rZXkpXG4gICAgICAgIGN0bi5pbnNlcnRCZWZvcmUodGhpcy5yZWYsIGVsKVxuICAgICAgICBjdG4ucmVtb3ZlQ2hpbGQoZWwpXG5cbiAgICAgICAgdGhpcy5jb2xsZWN0aW9uID0gbnVsbFxuICAgICAgICB0aGlzLnZtcyA9IG51bGxcblxuICAgIH0sXG5cbiAgICB1cGRhdGU6IGZ1bmN0aW9uIChjb2xsZWN0aW9uKSB7XG5cbiAgICAgICAgaWYgKCFBcnJheS5pc0FycmF5KGNvbGxlY3Rpb24pKSB7XG4gICAgICAgICAgICBpZiAodXRpbHMuaXNPYmplY3QoY29sbGVjdGlvbikpIHtcbiAgICAgICAgICAgICAgICBjb2xsZWN0aW9uID0gdXRpbHMub2JqZWN0VG9BcnJheShjb2xsZWN0aW9uKVxuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICB1dGlscy53YXJuKCd2LXJlcGVhdCBvbmx5IGFjY2VwdHMgQXJyYXkgb3IgT2JqZWN0IHZhbHVlcy4nKVxuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgLy8ga2VlcCByZWZlcmVuY2Ugb2Ygb2xkIGRhdGEgYW5kIFZNc1xuICAgICAgICAvLyBzbyB3ZSBjYW4gcmV1c2UgdGhlbSBpZiBwb3NzaWJsZVxuICAgICAgICB0aGlzLm9sZFZNcyA9IHRoaXMudm1zXG4gICAgICAgIHRoaXMub2xkQ29sbGVjdGlvbiA9IHRoaXMuY29sbGVjdGlvblxuICAgICAgICBjb2xsZWN0aW9uID0gdGhpcy5jb2xsZWN0aW9uID0gY29sbGVjdGlvbiB8fCBbXVxuXG4gICAgICAgIHZhciBpc09iamVjdCA9IGNvbGxlY3Rpb25bMF0gJiYgdXRpbHMuaXNPYmplY3QoY29sbGVjdGlvblswXSlcbiAgICAgICAgdGhpcy52bXMgPSB0aGlzLm9sZENvbGxlY3Rpb25cbiAgICAgICAgICAgID8gdGhpcy5kaWZmKGNvbGxlY3Rpb24sIGlzT2JqZWN0KVxuICAgICAgICAgICAgOiB0aGlzLmluaXQoY29sbGVjdGlvbiwgaXNPYmplY3QpXG5cbiAgICAgICAgaWYgKHRoaXMuY2hpbGRJZCkge1xuICAgICAgICAgICAgdGhpcy52bS4kW3RoaXMuY2hpbGRJZF0gPSB0aGlzLnZtc1xuICAgICAgICB9XG5cbiAgICB9LFxuXG4gICAgaW5pdDogZnVuY3Rpb24gKGNvbGxlY3Rpb24sIGlzT2JqZWN0KSB7XG4gICAgICAgIHZhciB2bSwgdm1zID0gW11cbiAgICAgICAgZm9yICh2YXIgaSA9IDAsIGwgPSBjb2xsZWN0aW9uLmxlbmd0aDsgaSA8IGw7IGkrKykge1xuICAgICAgICAgICAgdm0gPSB0aGlzLmJ1aWxkKGNvbGxlY3Rpb25baV0sIGksIGlzT2JqZWN0KVxuICAgICAgICAgICAgdm1zLnB1c2godm0pXG4gICAgICAgICAgICBpZiAodGhpcy5jb21waWxlci5pbml0KSB7XG4gICAgICAgICAgICAgICAgdGhpcy5jb250YWluZXIuaW5zZXJ0QmVmb3JlKHZtLiRlbCwgdGhpcy5yZWYpXG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIHZtLiRiZWZvcmUodGhpcy5yZWYpXG4gICAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIHZtc1xuICAgIH0sXG5cbiAgICAvKipcbiAgICAgKiAgRGlmZiB0aGUgbmV3IGFycmF5IHdpdGggdGhlIG9sZFxuICAgICAqICBhbmQgZGV0ZXJtaW5lIHRoZSBtaW5pbXVtIGFtb3VudCBvZiBET00gbWFuaXB1bGF0aW9ucy5cbiAgICAgKi9cbiAgICBkaWZmOiBmdW5jdGlvbiAobmV3Q29sbGVjdGlvbiwgaXNPYmplY3QpIHtcblxuICAgICAgICB2YXIgaSwgbCwgaXRlbSwgdm0sXG4gICAgICAgICAgICBvbGRJbmRleCxcbiAgICAgICAgICAgIHRhcmdldE5leHQsXG4gICAgICAgICAgICBjdXJyZW50TmV4dCxcbiAgICAgICAgICAgIG5leHRFbCxcbiAgICAgICAgICAgIGN0biAgICA9IHRoaXMuY29udGFpbmVyLFxuICAgICAgICAgICAgb2xkVk1zID0gdGhpcy5vbGRWTXMsXG4gICAgICAgICAgICB2bXMgICAgPSBbXVxuXG4gICAgICAgIHZtcy5sZW5ndGggPSBuZXdDb2xsZWN0aW9uLmxlbmd0aFxuXG4gICAgICAgIC8vIGZpcnN0IHBhc3MsIGNvbGxlY3QgbmV3IHJldXNlZCBhbmQgbmV3IGNyZWF0ZWRcbiAgICAgICAgZm9yIChpID0gMCwgbCA9IG5ld0NvbGxlY3Rpb24ubGVuZ3RoOyBpIDwgbDsgaSsrKSB7XG4gICAgICAgICAgICBpdGVtID0gbmV3Q29sbGVjdGlvbltpXVxuICAgICAgICAgICAgaWYgKGlzT2JqZWN0KSB7XG4gICAgICAgICAgICAgICAgaXRlbS4kaW5kZXggPSBpXG4gICAgICAgICAgICAgICAgaWYgKGl0ZW0uX19lbWl0dGVyX18gJiYgaXRlbS5fX2VtaXR0ZXJfX1t0aGlzLmlkZW50aWZpZXJdKSB7XG4gICAgICAgICAgICAgICAgICAgIC8vIHRoaXMgcGllY2Ugb2YgZGF0YSBpcyBiZWluZyByZXVzZWQuXG4gICAgICAgICAgICAgICAgICAgIC8vIHJlY29yZCBpdHMgZmluYWwgcG9zaXRpb24gaW4gcmV1c2VkIHZtc1xuICAgICAgICAgICAgICAgICAgICBpdGVtLiRyZXVzZWQgPSB0cnVlXG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgdm1zW2ldID0gdGhpcy5idWlsZChpdGVtLCBpLCBpc09iamVjdClcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIC8vIHdlIGNhbid0IGF0dGFjaCBhbiBpZGVudGlmaWVyIHRvIHByaW1pdGl2ZSB2YWx1ZXNcbiAgICAgICAgICAgICAgICAvLyBzbyBoYXZlIHRvIGRvIGFuIGluZGV4T2YuLi5cbiAgICAgICAgICAgICAgICBvbGRJbmRleCA9IGluZGV4T2Yob2xkVk1zLCBpdGVtKVxuICAgICAgICAgICAgICAgIGlmIChvbGRJbmRleCA+IC0xKSB7XG4gICAgICAgICAgICAgICAgICAgIC8vIHJlY29yZCB0aGUgcG9zaXRpb24gb24gdGhlIGV4aXN0aW5nIHZtXG4gICAgICAgICAgICAgICAgICAgIG9sZFZNc1tvbGRJbmRleF0uJHJldXNlZCA9IHRydWVcbiAgICAgICAgICAgICAgICAgICAgb2xkVk1zW29sZEluZGV4XS4kZGF0YS4kaW5kZXggPSBpXG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgdm1zW2ldID0gdGhpcy5idWlsZChpdGVtLCBpLCBpc09iamVjdClcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICAvLyBzZWNvbmQgcGFzcywgY29sbGVjdCBvbGQgcmV1c2VkIGFuZCBkZXN0cm95IHVudXNlZFxuICAgICAgICBmb3IgKGkgPSAwLCBsID0gb2xkVk1zLmxlbmd0aDsgaSA8IGw7IGkrKykge1xuICAgICAgICAgICAgdm0gPSBvbGRWTXNbaV1cbiAgICAgICAgICAgIGl0ZW0gPSB0aGlzLmFyZ1xuICAgICAgICAgICAgICAgID8gdm0uJGRhdGFbdGhpcy5hcmddXG4gICAgICAgICAgICAgICAgOiB2bS4kZGF0YVxuICAgICAgICAgICAgaWYgKGl0ZW0uJHJldXNlZCkge1xuICAgICAgICAgICAgICAgIHZtLiRyZXVzZWQgPSB0cnVlXG4gICAgICAgICAgICAgICAgZGVsZXRlIGl0ZW0uJHJldXNlZFxuICAgICAgICAgICAgfVxuICAgICAgICAgICAgaWYgKHZtLiRyZXVzZWQpIHtcbiAgICAgICAgICAgICAgICAvLyB1cGRhdGUgdGhlIGluZGV4IHRvIGxhdGVzdFxuICAgICAgICAgICAgICAgIHZtLiRpbmRleCA9IGl0ZW0uJGluZGV4XG4gICAgICAgICAgICAgICAgLy8gdGhlIGl0ZW0gY291bGQgaGF2ZSBoYWQgYSBuZXcga2V5XG4gICAgICAgICAgICAgICAgaWYgKGl0ZW0uJGtleSAmJiBpdGVtLiRrZXkgIT09IHZtLiRrZXkpIHtcbiAgICAgICAgICAgICAgICAgICAgdm0uJGtleSA9IGl0ZW0uJGtleVxuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB2bXNbdm0uJGluZGV4XSA9IHZtXG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIC8vIHRoaXMgb25lIGNhbiBiZSBkZXN0cm95ZWQuXG4gICAgICAgICAgICAgICAgaWYgKGl0ZW0uX19lbWl0dGVyX18pIHtcbiAgICAgICAgICAgICAgICAgICAgZGVsZXRlIGl0ZW0uX19lbWl0dGVyX19bdGhpcy5pZGVudGlmaWVyXVxuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB2bS4kZGVzdHJveSgpXG4gICAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICAvLyBmaW5hbCBwYXNzLCBtb3ZlL2luc2VydCBET00gZWxlbWVudHNcbiAgICAgICAgaSA9IHZtcy5sZW5ndGhcbiAgICAgICAgd2hpbGUgKGktLSkge1xuICAgICAgICAgICAgdm0gPSB2bXNbaV1cbiAgICAgICAgICAgIGl0ZW0gPSB2bS4kZGF0YVxuICAgICAgICAgICAgdGFyZ2V0TmV4dCA9IHZtc1tpICsgMV1cbiAgICAgICAgICAgIGlmICh2bS4kcmV1c2VkKSB7XG4gICAgICAgICAgICAgICAgbmV4dEVsID0gdm0uJGVsLm5leHRTaWJsaW5nXG4gICAgICAgICAgICAgICAgLy8gZGVzdHJveWVkIFZNcycgZWxlbWVudCBtaWdodCBzdGlsbCBiZSBpbiB0aGUgRE9NXG4gICAgICAgICAgICAgICAgLy8gZHVlIHRvIHRyYW5zaXRpb25zXG4gICAgICAgICAgICAgICAgd2hpbGUgKCFuZXh0RWwudnVlX3ZtICYmIG5leHRFbCAhPT0gdGhpcy5yZWYpIHtcbiAgICAgICAgICAgICAgICAgICAgbmV4dEVsID0gbmV4dEVsLm5leHRTaWJsaW5nXG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIGN1cnJlbnROZXh0ID0gbmV4dEVsLnZ1ZV92bVxuICAgICAgICAgICAgICAgIGlmIChjdXJyZW50TmV4dCAhPT0gdGFyZ2V0TmV4dCkge1xuICAgICAgICAgICAgICAgICAgICBpZiAoIXRhcmdldE5leHQpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGN0bi5pbnNlcnRCZWZvcmUodm0uJGVsLCB0aGlzLnJlZilcbiAgICAgICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIG5leHRFbCA9IHRhcmdldE5leHQuJGVsXG4gICAgICAgICAgICAgICAgICAgICAgICAvLyBuZXcgVk1zJyBlbGVtZW50IG1pZ2h0IG5vdCBiZSBpbiB0aGUgRE9NIHlldFxuICAgICAgICAgICAgICAgICAgICAgICAgLy8gZHVlIHRvIHRyYW5zaXRpb25zXG4gICAgICAgICAgICAgICAgICAgICAgICB3aGlsZSAoIW5leHRFbC5wYXJlbnROb2RlKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgdGFyZ2V0TmV4dCA9IHZtc1tuZXh0RWwudnVlX3ZtLiRpbmRleCArIDFdXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgbmV4dEVsID0gdGFyZ2V0TmV4dFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICA/IHRhcmdldE5leHQuJGVsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIDogdGhpcy5yZWZcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgICAgIGN0bi5pbnNlcnRCZWZvcmUodm0uJGVsLCBuZXh0RWwpXG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgZGVsZXRlIHZtLiRyZXVzZWRcbiAgICAgICAgICAgICAgICBkZWxldGUgaXRlbS4kaW5kZXhcbiAgICAgICAgICAgICAgICBkZWxldGUgaXRlbS4ka2V5XG4gICAgICAgICAgICB9IGVsc2UgeyAvLyBhIG5ldyB2bVxuICAgICAgICAgICAgICAgIHZtLiRiZWZvcmUodGFyZ2V0TmV4dCA/IHRhcmdldE5leHQuJGVsIDogdGhpcy5yZWYpXG4gICAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gdm1zXG4gICAgfSxcblxuICAgIGJ1aWxkOiBmdW5jdGlvbiAoZGF0YSwgaW5kZXgsIGlzT2JqZWN0KSB7XG5cbiAgICAgICAgLy8gd3JhcCBub24tb2JqZWN0IHZhbHVlc1xuICAgICAgICB2YXIgcmF3LCBhbGlhcyxcbiAgICAgICAgICAgIHdyYXAgPSAhaXNPYmplY3QgfHwgdGhpcy5hcmdcbiAgICAgICAgaWYgKHdyYXApIHtcbiAgICAgICAgICAgIHJhdyA9IGRhdGFcbiAgICAgICAgICAgIGFsaWFzID0gdGhpcy5hcmcgfHwgJyR2YWx1ZSdcbiAgICAgICAgICAgIGRhdGEgPSB7fVxuICAgICAgICAgICAgZGF0YVthbGlhc10gPSByYXdcbiAgICAgICAgfVxuICAgICAgICBkYXRhLiRpbmRleCA9IGluZGV4XG5cbiAgICAgICAgdmFyIGVsID0gdGhpcy5lbC5jbG9uZU5vZGUodHJ1ZSksXG4gICAgICAgICAgICBDdG9yID0gdGhpcy5jb21waWxlci5yZXNvbHZlQ29tcG9uZW50KGVsLCBkYXRhKSxcbiAgICAgICAgICAgIHZtID0gbmV3IEN0b3Ioe1xuICAgICAgICAgICAgICAgIGVsOiBlbCxcbiAgICAgICAgICAgICAgICBkYXRhOiBkYXRhLFxuICAgICAgICAgICAgICAgIHBhcmVudDogdGhpcy52bSxcbiAgICAgICAgICAgICAgICBjb21waWxlck9wdGlvbnM6IHtcbiAgICAgICAgICAgICAgICAgICAgcmVwZWF0OiB0cnVlLFxuICAgICAgICAgICAgICAgICAgICBleHBDYWNoZTogdGhpcy5leHBDYWNoZVxuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0pXG5cbiAgICAgICAgaWYgKGlzT2JqZWN0KSB7XG4gICAgICAgICAgICAvLyBhdHRhY2ggYW4gaWVudW1lcmFibGUgaWRlbnRpZmllciB0byB0aGUgcmF3IGRhdGFcbiAgICAgICAgICAgIChyYXcgfHwgZGF0YSkuX19lbWl0dGVyX19bdGhpcy5pZGVudGlmaWVyXSA9IHRydWVcbiAgICAgICAgfVxuXG4gICAgICAgIGlmICh3cmFwKSB7XG4gICAgICAgICAgICB2YXIgc2VsZiA9IHRoaXMsXG4gICAgICAgICAgICAgICAgc3luYyA9IGZ1bmN0aW9uICh2YWwpIHtcbiAgICAgICAgICAgICAgICAgICAgc2VsZi5sb2NrID0gdHJ1ZVxuICAgICAgICAgICAgICAgICAgICBzZWxmLmNvbGxlY3Rpb24uJHNldCh2bS4kaW5kZXgsIHZhbClcbiAgICAgICAgICAgICAgICAgICAgc2VsZi5sb2NrID0gZmFsc2VcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB2bS4kY29tcGlsZXIub2JzZXJ2ZXIub24oJ2NoYW5nZTonICsgYWxpYXMsIHN5bmMpXG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gdm1cblxuICAgIH0sXG5cbiAgICB1bmJpbmQ6IGZ1bmN0aW9uICgpIHtcbiAgICAgICAgaWYgKHRoaXMuY2hpbGRJZCkge1xuICAgICAgICAgICAgZGVsZXRlIHRoaXMudm0uJFt0aGlzLmNoaWxkSWRdXG4gICAgICAgIH1cbiAgICAgICAgaWYgKHRoaXMudm1zKSB7XG4gICAgICAgICAgICB2YXIgaSA9IHRoaXMudm1zLmxlbmd0aFxuICAgICAgICAgICAgd2hpbGUgKGktLSkge1xuICAgICAgICAgICAgICAgIHRoaXMudm1zW2ldLiRkZXN0cm95KClcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgIH1cbn1cblxuLy8gSGVscGVycyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXG4vKipcbiAqICBGaW5kIGFuIG9iamVjdCBvciBhIHdyYXBwZWQgZGF0YSBvYmplY3RcbiAqICBmcm9tIGFuIEFycmF5XG4gKi9cbmZ1bmN0aW9uIGluZGV4T2YgKHZtcywgb2JqKSB7XG4gICAgZm9yICh2YXIgdm0sIGkgPSAwLCBsID0gdm1zLmxlbmd0aDsgaSA8IGw7IGkrKykge1xuICAgICAgICB2bSA9IHZtc1tpXVxuICAgICAgICBpZiAoIXZtLiRyZXVzZWQgJiYgdm0uJHZhbHVlID09PSBvYmopIHtcbiAgICAgICAgICAgIHJldHVybiBpXG4gICAgICAgIH1cbiAgICB9XG4gICAgcmV0dXJuIC0xXG59IiwidmFyIGNhbWVsUkUgPSAvLShbYS16XSkvZyxcbiAgICBwcmVmaXhlcyA9IFsnd2Via2l0JywgJ21veicsICdtcyddXG5cbmZ1bmN0aW9uIGNhbWVsUmVwbGFjZXIgKG0pIHtcbiAgICByZXR1cm4gbVsxXS50b1VwcGVyQ2FzZSgpXG59XG5cbi8qKlxuICogIEJpbmRpbmcgZm9yIENTUyBzdHlsZXNcbiAqL1xubW9kdWxlLmV4cG9ydHMgPSB7XG5cbiAgICBiaW5kOiBmdW5jdGlvbiAoKSB7XG4gICAgICAgIHZhciBwcm9wID0gdGhpcy5hcmdcbiAgICAgICAgaWYgKCFwcm9wKSByZXR1cm5cbiAgICAgICAgdmFyIGZpcnN0ID0gcHJvcC5jaGFyQXQoMClcbiAgICAgICAgaWYgKGZpcnN0ID09PSAnJCcpIHtcbiAgICAgICAgICAgIC8vIHByb3BlcnRpZXMgdGhhdCBzdGFydCB3aXRoICQgd2lsbCBiZSBhdXRvLXByZWZpeGVkXG4gICAgICAgICAgICBwcm9wID0gcHJvcC5zbGljZSgxKVxuICAgICAgICAgICAgdGhpcy5wcmVmaXhlZCA9IHRydWVcbiAgICAgICAgfSBlbHNlIGlmIChmaXJzdCA9PT0gJy0nKSB7XG4gICAgICAgICAgICAvLyBub3JtYWwgc3RhcnRpbmcgaHlwaGVucyBzaG91bGQgbm90IGJlIGNvbnZlcnRlZFxuICAgICAgICAgICAgcHJvcCA9IHByb3Auc2xpY2UoMSlcbiAgICAgICAgfVxuICAgICAgICB0aGlzLnByb3AgPSBwcm9wLnJlcGxhY2UoY2FtZWxSRSwgY2FtZWxSZXBsYWNlcilcbiAgICB9LFxuXG4gICAgdXBkYXRlOiBmdW5jdGlvbiAodmFsdWUpIHtcbiAgICAgICAgdmFyIHByb3AgPSB0aGlzLnByb3BcbiAgICAgICAgaWYgKHByb3ApIHtcbiAgICAgICAgICAgIHRoaXMuZWwuc3R5bGVbcHJvcF0gPSB2YWx1ZVxuICAgICAgICAgICAgaWYgKHRoaXMucHJlZml4ZWQpIHtcbiAgICAgICAgICAgICAgICBwcm9wID0gcHJvcC5jaGFyQXQoMCkudG9VcHBlckNhc2UoKSArIHByb3Auc2xpY2UoMSlcbiAgICAgICAgICAgICAgICB2YXIgaSA9IHByZWZpeGVzLmxlbmd0aFxuICAgICAgICAgICAgICAgIHdoaWxlIChpLS0pIHtcbiAgICAgICAgICAgICAgICAgICAgdGhpcy5lbC5zdHlsZVtwcmVmaXhlc1tpXSArIHByb3BdID0gdmFsdWVcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICB0aGlzLmVsLnN0eWxlLmNzc1RleHQgPSB2YWx1ZVxuICAgICAgICB9XG4gICAgfVxuXG59IiwiLyoqXG4gKiAgTWFuYWdlcyBhIGNvbmRpdGlvbmFsIGNoaWxkIFZNIHVzaW5nIHRoZVxuICogIGJpbmRpbmcncyB2YWx1ZSBhcyB0aGUgY29tcG9uZW50IElELlxuICovXG5tb2R1bGUuZXhwb3J0cyA9IHtcblxuICAgIGJpbmQ6IGZ1bmN0aW9uICgpIHtcblxuICAgICAgICAvLyB0cmFjayBwb3NpdGlvbiBpbiBET00gd2l0aCBhIHJlZiBub2RlXG4gICAgICAgIHZhciBlbCAgICAgICA9IHRoaXMucmF3ID0gdGhpcy5lbCxcbiAgICAgICAgICAgIHBhcmVudCAgID0gZWwucGFyZW50Tm9kZSxcbiAgICAgICAgICAgIHJlZiAgICAgID0gdGhpcy5yZWYgPSBkb2N1bWVudC5jcmVhdGVDb21tZW50KCd2LXZpZXcnKVxuICAgICAgICBwYXJlbnQuaW5zZXJ0QmVmb3JlKHJlZiwgZWwpXG4gICAgICAgIHBhcmVudC5yZW1vdmVDaGlsZChlbClcblxuICAgICAgICAvLyBjYWNoZSBvcmlnaW5hbCBjb250ZW50XG4gICAgICAgIC8qIGpzaGludCBib3NzOiB0cnVlICovXG4gICAgICAgIHZhciBub2RlLFxuICAgICAgICAgICAgZnJhZyA9IHRoaXMuaW5uZXIgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdkaXYnKVxuICAgICAgICB3aGlsZSAobm9kZSA9IGVsLmZpcnN0Q2hpbGQpIHtcbiAgICAgICAgICAgIGZyYWcuYXBwZW5kQ2hpbGQobm9kZSlcbiAgICAgICAgfVxuXG4gICAgfSxcblxuICAgIHVwZGF0ZTogZnVuY3Rpb24odmFsdWUpIHtcblxuICAgICAgICB0aGlzLl91bmJpbmQoKVxuXG4gICAgICAgIHZhciBDdG9yICA9IHRoaXMuY29tcGlsZXIuZ2V0T3B0aW9uKCdjb21wb25lbnRzJywgdmFsdWUpXG4gICAgICAgIGlmICghQ3RvcikgcmV0dXJuXG5cbiAgICAgICAgdGhpcy5jaGlsZFZNID0gbmV3IEN0b3Ioe1xuICAgICAgICAgICAgZWw6IHRoaXMucmF3LmNsb25lTm9kZSh0cnVlKSxcbiAgICAgICAgICAgIHBhcmVudDogdGhpcy52bSxcbiAgICAgICAgICAgIGNvbXBpbGVyT3B0aW9uczoge1xuICAgICAgICAgICAgICAgIHJhd0NvbnRlbnQ6IHRoaXMuaW5uZXIuY2xvbmVOb2RlKHRydWUpXG4gICAgICAgICAgICB9XG4gICAgICAgIH0pXG5cbiAgICAgICAgdGhpcy5lbCA9IHRoaXMuY2hpbGRWTS4kZWxcbiAgICAgICAgaWYgKHRoaXMuY29tcGlsZXIuaW5pdCkge1xuICAgICAgICAgICAgdGhpcy5yZWYucGFyZW50Tm9kZS5pbnNlcnRCZWZvcmUodGhpcy5lbCwgdGhpcy5yZWYpXG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICB0aGlzLmNoaWxkVk0uJGJlZm9yZSh0aGlzLnJlZilcbiAgICAgICAgfVxuXG4gICAgfSxcblxuICAgIHVuYmluZDogZnVuY3Rpb24oKSB7XG4gICAgICAgIGlmICh0aGlzLmNoaWxkVk0pIHtcbiAgICAgICAgICAgIHRoaXMuY2hpbGRWTS4kZGVzdHJveSgpXG4gICAgICAgIH1cbiAgICB9XG5cbn0iLCJ2YXIgdXRpbHMgPSByZXF1aXJlKCcuLi91dGlscycpXG5cbi8qKlxuICogIEJpbmRpbmcgZm9yIGluaGVyaXRpbmcgZGF0YSBmcm9tIHBhcmVudCBWTXMuXG4gKi9cbm1vZHVsZS5leHBvcnRzID0ge1xuXG4gICAgYmluZDogZnVuY3Rpb24gKCkge1xuXG4gICAgICAgIHZhciBzZWxmICAgICAgPSB0aGlzLFxuICAgICAgICAgICAgY2hpbGRLZXkgID0gc2VsZi5hcmcsXG4gICAgICAgICAgICBwYXJlbnRLZXkgPSBzZWxmLmtleSxcbiAgICAgICAgICAgIGNvbXBpbGVyICA9IHNlbGYuY29tcGlsZXIsXG4gICAgICAgICAgICBvd25lciAgICAgPSBzZWxmLmJpbmRpbmcuY29tcGlsZXJcblxuICAgICAgICBpZiAoY29tcGlsZXIgPT09IG93bmVyKSB7XG4gICAgICAgICAgICB0aGlzLmFsb25lID0gdHJ1ZVxuICAgICAgICAgICAgcmV0dXJuXG4gICAgICAgIH1cblxuICAgICAgICBpZiAoY2hpbGRLZXkpIHtcbiAgICAgICAgICAgIGlmICghY29tcGlsZXIuYmluZGluZ3NbY2hpbGRLZXldKSB7XG4gICAgICAgICAgICAgICAgY29tcGlsZXIuY3JlYXRlQmluZGluZyhjaGlsZEtleSlcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIC8vIHN5bmMgY2hhbmdlcyBvbiBjaGlsZCBiYWNrIHRvIHBhcmVudFxuICAgICAgICAgICAgY29tcGlsZXIub2JzZXJ2ZXIub24oJ2NoYW5nZTonICsgY2hpbGRLZXksIGZ1bmN0aW9uICh2YWwpIHtcbiAgICAgICAgICAgICAgICBpZiAoY29tcGlsZXIuaW5pdCkgcmV0dXJuXG4gICAgICAgICAgICAgICAgaWYgKCFzZWxmLmxvY2spIHtcbiAgICAgICAgICAgICAgICAgICAgc2VsZi5sb2NrID0gdHJ1ZVxuICAgICAgICAgICAgICAgICAgICB1dGlscy5uZXh0VGljayhmdW5jdGlvbiAoKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBzZWxmLmxvY2sgPSBmYWxzZVxuICAgICAgICAgICAgICAgICAgICB9KVxuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBvd25lci52bS4kc2V0KHBhcmVudEtleSwgdmFsKVxuICAgICAgICAgICAgfSlcbiAgICAgICAgfVxuICAgIH0sXG5cbiAgICB1cGRhdGU6IGZ1bmN0aW9uICh2YWx1ZSkge1xuICAgICAgICAvLyBzeW5jIGZyb20gcGFyZW50XG4gICAgICAgIGlmICghdGhpcy5hbG9uZSAmJiAhdGhpcy5sb2NrKSB7XG4gICAgICAgICAgICBpZiAodGhpcy5hcmcpIHtcbiAgICAgICAgICAgICAgICB0aGlzLnZtLiRzZXQodGhpcy5hcmcsIHZhbHVlKVxuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICB0aGlzLnZtLiRkYXRhID0gdmFsdWVcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgIH1cblxufSIsImZ1bmN0aW9uIEVtaXR0ZXIgKGN0eCkge1xuICAgIHRoaXMuX2N0eCA9IGN0eCB8fCB0aGlzXG59XG5cbnZhciBFbWl0dGVyUHJvdG8gPSBFbWl0dGVyLnByb3RvdHlwZVxuXG5FbWl0dGVyUHJvdG8ub24gPSBmdW5jdGlvbihldmVudCwgZm4pe1xuICAgIHRoaXMuX2NicyA9IHRoaXMuX2NicyB8fCB7fVxuICAgIDsodGhpcy5fY2JzW2V2ZW50XSA9IHRoaXMuX2Nic1tldmVudF0gfHwgW10pXG4gICAgICAgIC5wdXNoKGZuKVxuICAgIHJldHVybiB0aGlzXG59XG5cbkVtaXR0ZXJQcm90by5vbmNlID0gZnVuY3Rpb24oZXZlbnQsIGZuKXtcbiAgICB2YXIgc2VsZiA9IHRoaXNcbiAgICB0aGlzLl9jYnMgPSB0aGlzLl9jYnMgfHwge31cblxuICAgIGZ1bmN0aW9uIG9uICgpIHtcbiAgICAgICAgc2VsZi5vZmYoZXZlbnQsIG9uKVxuICAgICAgICBmbi5hcHBseSh0aGlzLCBhcmd1bWVudHMpXG4gICAgfVxuXG4gICAgb24uZm4gPSBmblxuICAgIHRoaXMub24oZXZlbnQsIG9uKVxuICAgIHJldHVybiB0aGlzXG59XG5cbkVtaXR0ZXJQcm90by5vZmYgPSBmdW5jdGlvbihldmVudCwgZm4pe1xuICAgIHRoaXMuX2NicyA9IHRoaXMuX2NicyB8fCB7fVxuXG4gICAgLy8gYWxsXG4gICAgaWYgKCFhcmd1bWVudHMubGVuZ3RoKSB7XG4gICAgICAgIHRoaXMuX2NicyA9IHt9XG4gICAgICAgIHJldHVybiB0aGlzXG4gICAgfVxuXG4gICAgLy8gc3BlY2lmaWMgZXZlbnRcbiAgICB2YXIgY2FsbGJhY2tzID0gdGhpcy5fY2JzW2V2ZW50XVxuICAgIGlmICghY2FsbGJhY2tzKSByZXR1cm4gdGhpc1xuXG4gICAgLy8gcmVtb3ZlIGFsbCBoYW5kbGVyc1xuICAgIGlmIChhcmd1bWVudHMubGVuZ3RoID09PSAxKSB7XG4gICAgICAgIGRlbGV0ZSB0aGlzLl9jYnNbZXZlbnRdXG4gICAgICAgIHJldHVybiB0aGlzXG4gICAgfVxuXG4gICAgLy8gcmVtb3ZlIHNwZWNpZmljIGhhbmRsZXJcbiAgICB2YXIgY2JcbiAgICBmb3IgKHZhciBpID0gMDsgaSA8IGNhbGxiYWNrcy5sZW5ndGg7IGkrKykge1xuICAgICAgICBjYiA9IGNhbGxiYWNrc1tpXVxuICAgICAgICBpZiAoY2IgPT09IGZuIHx8IGNiLmZuID09PSBmbikge1xuICAgICAgICAgICAgY2FsbGJhY2tzLnNwbGljZShpLCAxKVxuICAgICAgICAgICAgYnJlYWtcbiAgICAgICAgfVxuICAgIH1cbiAgICByZXR1cm4gdGhpc1xufVxuXG5FbWl0dGVyUHJvdG8uZW1pdCA9IGZ1bmN0aW9uKGV2ZW50LCBhLCBiLCBjKXtcbiAgICB0aGlzLl9jYnMgPSB0aGlzLl9jYnMgfHwge31cbiAgICB2YXIgY2FsbGJhY2tzID0gdGhpcy5fY2JzW2V2ZW50XVxuXG4gICAgaWYgKGNhbGxiYWNrcykge1xuICAgICAgICBjYWxsYmFja3MgPSBjYWxsYmFja3Muc2xpY2UoMClcbiAgICAgICAgZm9yICh2YXIgaSA9IDAsIGxlbiA9IGNhbGxiYWNrcy5sZW5ndGg7IGkgPCBsZW47IGkrKykge1xuICAgICAgICAgICAgY2FsbGJhY2tzW2ldLmNhbGwodGhpcy5fY3R4LCBhLCBiLCBjKVxuICAgICAgICB9XG4gICAgfVxuXG4gICAgcmV0dXJuIHRoaXNcbn1cblxubW9kdWxlLmV4cG9ydHMgPSBFbWl0dGVyIiwidmFyIHV0aWxzICAgICAgICAgICA9IHJlcXVpcmUoJy4vdXRpbHMnKSxcbiAgICBTVFJfU0FWRV9SRSAgICAgPSAvXCIoPzpbXlwiXFxcXF18XFxcXC4pKlwifCcoPzpbXidcXFxcXXxcXFxcLikqJy9nLFxuICAgIFNUUl9SRVNUT1JFX1JFICA9IC9cIihcXGQrKVwiL2csXG4gICAgTkVXTElORV9SRSAgICAgID0gL1xcbi9nLFxuICAgIENUT1JfUkUgICAgICAgICA9IG5ldyBSZWdFeHAoJ2NvbnN0cnVjdG9yJy5zcGxpdCgnJykuam9pbignW1xcJ1wiKywgXSonKSksXG4gICAgVU5JQ09ERV9SRSAgICAgID0gL1xcXFx1XFxkXFxkXFxkXFxkL1xuXG4vLyBWYXJpYWJsZSBleHRyYWN0aW9uIHNjb29wZWQgZnJvbSBodHRwczovL2dpdGh1Yi5jb20vUnVieUxvdXZyZS9hdmFsb25cblxudmFyIEtFWVdPUkRTID1cbiAgICAgICAgLy8ga2V5d29yZHNcbiAgICAgICAgJ2JyZWFrLGNhc2UsY2F0Y2gsY29udGludWUsZGVidWdnZXIsZGVmYXVsdCxkZWxldGUsZG8sZWxzZSxmYWxzZScgK1xuICAgICAgICAnLGZpbmFsbHksZm9yLGZ1bmN0aW9uLGlmLGluLGluc3RhbmNlb2YsbmV3LG51bGwscmV0dXJuLHN3aXRjaCx0aGlzJyArXG4gICAgICAgICcsdGhyb3csdHJ1ZSx0cnksdHlwZW9mLHZhcix2b2lkLHdoaWxlLHdpdGgsdW5kZWZpbmVkJyArXG4gICAgICAgIC8vIHJlc2VydmVkXG4gICAgICAgICcsYWJzdHJhY3QsYm9vbGVhbixieXRlLGNoYXIsY2xhc3MsY29uc3QsZG91YmxlLGVudW0sZXhwb3J0LGV4dGVuZHMnICtcbiAgICAgICAgJyxmaW5hbCxmbG9hdCxnb3RvLGltcGxlbWVudHMsaW1wb3J0LGludCxpbnRlcmZhY2UsbG9uZyxuYXRpdmUnICtcbiAgICAgICAgJyxwYWNrYWdlLHByaXZhdGUscHJvdGVjdGVkLHB1YmxpYyxzaG9ydCxzdGF0aWMsc3VwZXIsc3luY2hyb25pemVkJyArXG4gICAgICAgICcsdGhyb3dzLHRyYW5zaWVudCx2b2xhdGlsZScgK1xuICAgICAgICAvLyBFQ01BIDUgLSB1c2Ugc3RyaWN0XG4gICAgICAgICcsYXJndW1lbnRzLGxldCx5aWVsZCcgK1xuICAgICAgICAvLyBhbGxvdyB1c2luZyBNYXRoIGluIGV4cHJlc3Npb25zXG4gICAgICAgICcsTWF0aCcsXG4gICAgICAgIFxuICAgIEtFWVdPUkRTX1JFID0gbmV3IFJlZ0V4cChbXCJcXFxcYlwiICsgS0VZV09SRFMucmVwbGFjZSgvLC9nLCAnXFxcXGJ8XFxcXGInKSArIFwiXFxcXGJcIl0uam9pbignfCcpLCAnZycpLFxuICAgIFJFTU9WRV9SRSAgID0gL1xcL1xcKig/Oi58XFxuKSo/XFwqXFwvfFxcL1xcL1teXFxuXSpcXG58XFwvXFwvW15cXG5dKiR8J1teJ10qJ3xcIlteXCJdKlwifFtcXHNcXHRcXG5dKlxcLltcXHNcXHRcXG5dKlskXFx3XFwuXSsvZyxcbiAgICBTUExJVF9SRSAgICA9IC9bXlxcdyRdKy9nLFxuICAgIE5VTUJFUl9SRSAgID0gL1xcYlxcZFteLF0qL2csXG4gICAgQk9VTkRBUllfUkUgPSAvXiwrfCwrJC9nXG5cbi8qKlxuICogIFN0cmlwIHRvcCBsZXZlbCB2YXJpYWJsZSBuYW1lcyBmcm9tIGEgc25pcHBldCBvZiBKUyBleHByZXNzaW9uXG4gKi9cbmZ1bmN0aW9uIGdldFZhcmlhYmxlcyAoY29kZSkge1xuICAgIGNvZGUgPSBjb2RlXG4gICAgICAgIC5yZXBsYWNlKFJFTU9WRV9SRSwgJycpXG4gICAgICAgIC5yZXBsYWNlKFNQTElUX1JFLCAnLCcpXG4gICAgICAgIC5yZXBsYWNlKEtFWVdPUkRTX1JFLCAnJylcbiAgICAgICAgLnJlcGxhY2UoTlVNQkVSX1JFLCAnJylcbiAgICAgICAgLnJlcGxhY2UoQk9VTkRBUllfUkUsICcnKVxuICAgIHJldHVybiBjb2RlXG4gICAgICAgID8gY29kZS5zcGxpdCgvLCsvKVxuICAgICAgICA6IFtdXG59XG5cbi8qKlxuICogIEEgZ2l2ZW4gcGF0aCBjb3VsZCBwb3RlbnRpYWxseSBleGlzdCBub3Qgb24gdGhlXG4gKiAgY3VycmVudCBjb21waWxlciwgYnV0IHVwIGluIHRoZSBwYXJlbnQgY2hhaW4gc29tZXdoZXJlLlxuICogIFRoaXMgZnVuY3Rpb24gZ2VuZXJhdGVzIGFuIGFjY2VzcyByZWxhdGlvbnNoaXAgc3RyaW5nXG4gKiAgdGhhdCBjYW4gYmUgdXNlZCBpbiB0aGUgZ2V0dGVyIGZ1bmN0aW9uIGJ5IHdhbGtpbmcgdXBcbiAqICB0aGUgcGFyZW50IGNoYWluIHRvIGNoZWNrIGZvciBrZXkgZXhpc3RlbmNlLlxuICpcbiAqICBJdCBzdG9wcyBhdCB0b3AgcGFyZW50IGlmIG5vIHZtIGluIHRoZSBjaGFpbiBoYXMgdGhlXG4gKiAga2V5LiBJdCB0aGVuIGNyZWF0ZXMgYW55IG1pc3NpbmcgYmluZGluZ3Mgb24gdGhlXG4gKiAgZmluYWwgcmVzb2x2ZWQgdm0uXG4gKi9cbmZ1bmN0aW9uIHRyYWNlU2NvcGUgKHBhdGgsIGNvbXBpbGVyLCBkYXRhKSB7XG4gICAgdmFyIHJlbCAgPSAnJyxcbiAgICAgICAgZGlzdCA9IDAsXG4gICAgICAgIHNlbGYgPSBjb21waWxlclxuXG4gICAgaWYgKGRhdGEgJiYgdXRpbHMuZ2V0KGRhdGEsIHBhdGgpICE9PSB1bmRlZmluZWQpIHtcbiAgICAgICAgLy8gaGFjazogdGVtcG9yYXJpbHkgYXR0YWNoZWQgZGF0YVxuICAgICAgICByZXR1cm4gJyR0ZW1wLidcbiAgICB9XG5cbiAgICB3aGlsZSAoY29tcGlsZXIpIHtcbiAgICAgICAgaWYgKGNvbXBpbGVyLmhhc0tleShwYXRoKSkge1xuICAgICAgICAgICAgYnJlYWtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIGNvbXBpbGVyID0gY29tcGlsZXIucGFyZW50XG4gICAgICAgICAgICBkaXN0KytcbiAgICAgICAgfVxuICAgIH1cbiAgICBpZiAoY29tcGlsZXIpIHtcbiAgICAgICAgd2hpbGUgKGRpc3QtLSkge1xuICAgICAgICAgICAgcmVsICs9ICckcGFyZW50LidcbiAgICAgICAgfVxuICAgICAgICBpZiAoIWNvbXBpbGVyLmJpbmRpbmdzW3BhdGhdICYmIHBhdGguY2hhckF0KDApICE9PSAnJCcpIHtcbiAgICAgICAgICAgIGNvbXBpbGVyLmNyZWF0ZUJpbmRpbmcocGF0aClcbiAgICAgICAgfVxuICAgIH0gZWxzZSB7XG4gICAgICAgIHNlbGYuY3JlYXRlQmluZGluZyhwYXRoKVxuICAgIH1cbiAgICByZXR1cm4gcmVsXG59XG5cbi8qKlxuICogIENyZWF0ZSBhIGZ1bmN0aW9uIGZyb20gYSBzdHJpbmcuLi5cbiAqICB0aGlzIGxvb2tzIGxpa2UgZXZpbCBtYWdpYyBidXQgc2luY2UgYWxsIHZhcmlhYmxlcyBhcmUgbGltaXRlZFxuICogIHRvIHRoZSBWTSdzIGRhdGEgaXQncyBhY3R1YWxseSBwcm9wZXJseSBzYW5kYm94ZWRcbiAqL1xuZnVuY3Rpb24gbWFrZUdldHRlciAoZXhwLCByYXcpIHtcbiAgICB2YXIgZm5cbiAgICB0cnkge1xuICAgICAgICBmbiA9IG5ldyBGdW5jdGlvbihleHApXG4gICAgfSBjYXRjaCAoZSkge1xuICAgICAgICB1dGlscy53YXJuKCdFcnJvciBwYXJzaW5nIGV4cHJlc3Npb246ICcgKyByYXcpXG4gICAgfVxuICAgIHJldHVybiBmblxufVxuXG4vKipcbiAqICBFc2NhcGUgYSBsZWFkaW5nIGRvbGxhciBzaWduIGZvciByZWdleCBjb25zdHJ1Y3Rpb25cbiAqL1xuZnVuY3Rpb24gZXNjYXBlRG9sbGFyICh2KSB7XG4gICAgcmV0dXJuIHYuY2hhckF0KDApID09PSAnJCdcbiAgICAgICAgPyAnXFxcXCcgKyB2XG4gICAgICAgIDogdlxufVxuXG4vKipcbiAqICBQYXJzZSBhbmQgcmV0dXJuIGFuIGFub255bW91cyBjb21wdXRlZCBwcm9wZXJ0eSBnZXR0ZXIgZnVuY3Rpb25cbiAqICBmcm9tIGFuIGFyYml0cmFyeSBleHByZXNzaW9uLCB0b2dldGhlciB3aXRoIGEgbGlzdCBvZiBwYXRocyB0byBiZVxuICogIGNyZWF0ZWQgYXMgYmluZGluZ3MuXG4gKi9cbmV4cG9ydHMucGFyc2UgPSBmdW5jdGlvbiAoZXhwLCBjb21waWxlciwgZGF0YSkge1xuICAgIC8vIHVuaWNvZGUgYW5kICdjb25zdHJ1Y3RvcicgYXJlIG5vdCBhbGxvd2VkIGZvciBYU1Mgc2VjdXJpdHkuXG4gICAgaWYgKFVOSUNPREVfUkUudGVzdChleHApIHx8IENUT1JfUkUudGVzdChleHApKSB7XG4gICAgICAgIHV0aWxzLndhcm4oJ1Vuc2FmZSBleHByZXNzaW9uOiAnICsgZXhwKVxuICAgICAgICByZXR1cm5cbiAgICB9XG4gICAgLy8gZXh0cmFjdCB2YXJpYWJsZSBuYW1lc1xuICAgIHZhciB2YXJzID0gZ2V0VmFyaWFibGVzKGV4cClcbiAgICBpZiAoIXZhcnMubGVuZ3RoKSB7XG4gICAgICAgIHJldHVybiBtYWtlR2V0dGVyKCdyZXR1cm4gJyArIGV4cCwgZXhwKVxuICAgIH1cbiAgICB2YXJzID0gdXRpbHMudW5pcXVlKHZhcnMpXG5cbiAgICB2YXIgYWNjZXNzb3JzID0gJycsXG4gICAgICAgIGhhcyAgICAgICA9IHV0aWxzLmhhc2goKSxcbiAgICAgICAgc3RyaW5ncyAgID0gW10sXG4gICAgICAgIC8vIGNvbnN0cnVjdCBhIHJlZ2V4IHRvIGV4dHJhY3QgYWxsIHZhbGlkIHZhcmlhYmxlIHBhdGhzXG4gICAgICAgIC8vIG9uZXMgdGhhdCBiZWdpbiB3aXRoIFwiJFwiIGFyZSBwYXJ0aWN1bGFybHkgdHJpY2t5XG4gICAgICAgIC8vIGJlY2F1c2Ugd2UgY2FuJ3QgdXNlIFxcYiBmb3IgdGhlbVxuICAgICAgICBwYXRoUkUgPSBuZXcgUmVnRXhwKFxuICAgICAgICAgICAgXCJbXiRcXFxcd1xcXFwuXShcIiArXG4gICAgICAgICAgICB2YXJzLm1hcChlc2NhcGVEb2xsYXIpLmpvaW4oJ3wnKSArXG4gICAgICAgICAgICBcIilbJFxcXFx3XFxcXC5dKlxcXFxiXCIsICdnJ1xuICAgICAgICApLFxuICAgICAgICBib2R5ID0gKCcgJyArIGV4cClcbiAgICAgICAgICAgIC5yZXBsYWNlKFNUUl9TQVZFX1JFLCBzYXZlU3RyaW5ncylcbiAgICAgICAgICAgIC5yZXBsYWNlKHBhdGhSRSwgcmVwbGFjZVBhdGgpXG4gICAgICAgICAgICAucmVwbGFjZShTVFJfUkVTVE9SRV9SRSwgcmVzdG9yZVN0cmluZ3MpXG5cbiAgICBib2R5ID0gYWNjZXNzb3JzICsgJ3JldHVybiAnICsgYm9keVxuXG4gICAgZnVuY3Rpb24gc2F2ZVN0cmluZ3MgKHN0cikge1xuICAgICAgICB2YXIgaSA9IHN0cmluZ3MubGVuZ3RoXG4gICAgICAgIC8vIGVzY2FwZSBuZXdsaW5lcyBpbiBzdHJpbmdzIHNvIHRoZSBleHByZXNzaW9uXG4gICAgICAgIC8vIGNhbiBiZSBjb3JyZWN0bHkgZXZhbHVhdGVkXG4gICAgICAgIHN0cmluZ3NbaV0gPSBzdHIucmVwbGFjZShORVdMSU5FX1JFLCAnXFxcXG4nKVxuICAgICAgICByZXR1cm4gJ1wiJyArIGkgKyAnXCInXG4gICAgfVxuXG4gICAgZnVuY3Rpb24gcmVwbGFjZVBhdGggKHBhdGgpIHtcbiAgICAgICAgLy8ga2VlcCB0cmFjayBvZiB0aGUgZmlyc3QgY2hhclxuICAgICAgICB2YXIgYyA9IHBhdGguY2hhckF0KDApXG4gICAgICAgIHBhdGggPSBwYXRoLnNsaWNlKDEpXG4gICAgICAgIHZhciB2YWwgPSAndGhpcy4nICsgdHJhY2VTY29wZShwYXRoLCBjb21waWxlciwgZGF0YSkgKyBwYXRoXG4gICAgICAgIGlmICghaGFzW3BhdGhdKSB7XG4gICAgICAgICAgICBhY2Nlc3NvcnMgKz0gdmFsICsgJzsnXG4gICAgICAgICAgICBoYXNbcGF0aF0gPSAxXG4gICAgICAgIH1cbiAgICAgICAgLy8gZG9uJ3QgZm9yZ2V0IHRvIHB1dCB0aGF0IGZpcnN0IGNoYXIgYmFja1xuICAgICAgICByZXR1cm4gYyArIHZhbFxuICAgIH1cblxuICAgIGZ1bmN0aW9uIHJlc3RvcmVTdHJpbmdzIChzdHIsIGkpIHtcbiAgICAgICAgcmV0dXJuIHN0cmluZ3NbaV1cbiAgICB9XG5cbiAgICByZXR1cm4gbWFrZUdldHRlcihib2R5LCBleHApXG59XG5cbi8qKlxuICogIEV2YWx1YXRlIGFuIGV4cHJlc3Npb24gaW4gdGhlIGNvbnRleHQgb2YgYSBjb21waWxlci5cbiAqICBBY2NlcHRzIGFkZGl0aW9uYWwgZGF0YS5cbiAqL1xuZXhwb3J0cy5ldmFsID0gZnVuY3Rpb24gKGV4cCwgY29tcGlsZXIsIGRhdGEpIHtcbiAgICB2YXIgZ2V0dGVyID0gZXhwb3J0cy5wYXJzZShleHAsIGNvbXBpbGVyLCBkYXRhKSwgcmVzXG4gICAgaWYgKGdldHRlcikge1xuICAgICAgICAvLyBoYWNrOiB0ZW1wb3JhcmlseSBhdHRhY2ggdGhlIGFkZGl0aW9uYWwgZGF0YSBzb1xuICAgICAgICAvLyBpdCBjYW4gYmUgYWNjZXNzZWQgaW4gdGhlIGdldHRlclxuICAgICAgICBjb21waWxlci52bS4kdGVtcCA9IGRhdGFcbiAgICAgICAgcmVzID0gZ2V0dGVyLmNhbGwoY29tcGlsZXIudm0pXG4gICAgICAgIGRlbGV0ZSBjb21waWxlci52bS4kdGVtcFxuICAgIH1cbiAgICByZXR1cm4gcmVzXG59IiwidmFyIHV0aWxzICAgID0gcmVxdWlyZSgnLi91dGlscycpLFxuICAgIGdldCAgICAgID0gdXRpbHMuZ2V0LFxuICAgIHNsaWNlICAgID0gW10uc2xpY2UsXG4gICAgUVVPVEVfUkUgPSAvXicuKickLyxcbiAgICBmaWx0ZXJzICA9IG1vZHVsZS5leHBvcnRzID0gdXRpbHMuaGFzaCgpXG5cbi8qKlxuICogICdhYmMnID0+ICdBYmMnXG4gKi9cbmZpbHRlcnMuY2FwaXRhbGl6ZSA9IGZ1bmN0aW9uICh2YWx1ZSkge1xuICAgIGlmICghdmFsdWUgJiYgdmFsdWUgIT09IDApIHJldHVybiAnJ1xuICAgIHZhbHVlID0gdmFsdWUudG9TdHJpbmcoKVxuICAgIHJldHVybiB2YWx1ZS5jaGFyQXQoMCkudG9VcHBlckNhc2UoKSArIHZhbHVlLnNsaWNlKDEpXG59XG5cbi8qKlxuICogICdhYmMnID0+ICdBQkMnXG4gKi9cbmZpbHRlcnMudXBwZXJjYXNlID0gZnVuY3Rpb24gKHZhbHVlKSB7XG4gICAgcmV0dXJuICh2YWx1ZSB8fCB2YWx1ZSA9PT0gMClcbiAgICAgICAgPyB2YWx1ZS50b1N0cmluZygpLnRvVXBwZXJDYXNlKClcbiAgICAgICAgOiAnJ1xufVxuXG4vKipcbiAqICAnQWJDJyA9PiAnYWJjJ1xuICovXG5maWx0ZXJzLmxvd2VyY2FzZSA9IGZ1bmN0aW9uICh2YWx1ZSkge1xuICAgIHJldHVybiAodmFsdWUgfHwgdmFsdWUgPT09IDApXG4gICAgICAgID8gdmFsdWUudG9TdHJpbmcoKS50b0xvd2VyQ2FzZSgpXG4gICAgICAgIDogJydcbn1cblxuLyoqXG4gKiAgMTIzNDUgPT4gJDEyLDM0NS4wMFxuICovXG5maWx0ZXJzLmN1cnJlbmN5ID0gZnVuY3Rpb24gKHZhbHVlLCBzaWduKSB7XG4gICAgaWYgKCF2YWx1ZSAmJiB2YWx1ZSAhPT0gMCkgcmV0dXJuICcnXG4gICAgc2lnbiA9IHNpZ24gfHwgJyQnXG4gICAgdmFyIHMgPSBNYXRoLmZsb29yKHZhbHVlKS50b1N0cmluZygpLFxuICAgICAgICBpID0gcy5sZW5ndGggJSAzLFxuICAgICAgICBoID0gaSA+IDAgPyAocy5zbGljZSgwLCBpKSArIChzLmxlbmd0aCA+IDMgPyAnLCcgOiAnJykpIDogJycsXG4gICAgICAgIGYgPSAnLicgKyB2YWx1ZS50b0ZpeGVkKDIpLnNsaWNlKC0yKVxuICAgIHJldHVybiBzaWduICsgaCArIHMuc2xpY2UoaSkucmVwbGFjZSgvKFxcZHszfSkoPz1cXGQpL2csICckMSwnKSArIGZcbn1cblxuLyoqXG4gKiAgYXJnczogYW4gYXJyYXkgb2Ygc3RyaW5ncyBjb3JyZXNwb25kaW5nIHRvXG4gKiAgdGhlIHNpbmdsZSwgZG91YmxlLCB0cmlwbGUgLi4uIGZvcm1zIG9mIHRoZSB3b3JkIHRvXG4gKiAgYmUgcGx1cmFsaXplZC4gV2hlbiB0aGUgbnVtYmVyIHRvIGJlIHBsdXJhbGl6ZWRcbiAqICBleGNlZWRzIHRoZSBsZW5ndGggb2YgdGhlIGFyZ3MsIGl0IHdpbGwgdXNlIHRoZSBsYXN0XG4gKiAgZW50cnkgaW4gdGhlIGFycmF5LlxuICpcbiAqICBlLmcuIFsnc2luZ2xlJywgJ2RvdWJsZScsICd0cmlwbGUnLCAnbXVsdGlwbGUnXVxuICovXG5maWx0ZXJzLnBsdXJhbGl6ZSA9IGZ1bmN0aW9uICh2YWx1ZSkge1xuICAgIHZhciBhcmdzID0gc2xpY2UuY2FsbChhcmd1bWVudHMsIDEpXG4gICAgcmV0dXJuIGFyZ3MubGVuZ3RoID4gMVxuICAgICAgICA/IChhcmdzW3ZhbHVlIC0gMV0gfHwgYXJnc1thcmdzLmxlbmd0aCAtIDFdKVxuICAgICAgICA6IChhcmdzW3ZhbHVlIC0gMV0gfHwgYXJnc1swXSArICdzJylcbn1cblxuLyoqXG4gKiAgQSBzcGVjaWFsIGZpbHRlciB0aGF0IHRha2VzIGEgaGFuZGxlciBmdW5jdGlvbixcbiAqICB3cmFwcyBpdCBzbyBpdCBvbmx5IGdldHMgdHJpZ2dlcmVkIG9uIHNwZWNpZmljIGtleXByZXNzZXMuXG4gKlxuICogIHYtb24gb25seVxuICovXG5cbnZhciBrZXlDb2RlcyA9IHtcbiAgICBlbnRlciAgICA6IDEzLFxuICAgIHRhYiAgICAgIDogOSxcbiAgICAnZGVsZXRlJyA6IDQ2LFxuICAgIHVwICAgICAgIDogMzgsXG4gICAgbGVmdCAgICAgOiAzNyxcbiAgICByaWdodCAgICA6IDM5LFxuICAgIGRvd24gICAgIDogNDAsXG4gICAgZXNjICAgICAgOiAyN1xufVxuXG5maWx0ZXJzLmtleSA9IGZ1bmN0aW9uIChoYW5kbGVyLCBrZXkpIHtcbiAgICBpZiAoIWhhbmRsZXIpIHJldHVyblxuICAgIHZhciBjb2RlID0ga2V5Q29kZXNba2V5XVxuICAgIGlmICghY29kZSkge1xuICAgICAgICBjb2RlID0gcGFyc2VJbnQoa2V5LCAxMClcbiAgICB9XG4gICAgcmV0dXJuIGZ1bmN0aW9uIChlKSB7XG4gICAgICAgIGlmIChlLmtleUNvZGUgPT09IGNvZGUpIHtcbiAgICAgICAgICAgIHJldHVybiBoYW5kbGVyLmNhbGwodGhpcywgZSlcbiAgICAgICAgfVxuICAgIH1cbn1cblxuLyoqXG4gKiAgRmlsdGVyIGZpbHRlciBmb3Igdi1yZXBlYXRcbiAqL1xuZmlsdGVycy5maWx0ZXJCeSA9IGZ1bmN0aW9uIChhcnIsIHNlYXJjaEtleSwgZGVsaW1pdGVyLCBkYXRhS2V5KSB7XG5cbiAgICAvLyBhbGxvdyBvcHRpb25hbCBgaW5gIGRlbGltaXRlclxuICAgIC8vIGJlY2F1c2Ugd2h5IG5vdFxuICAgIGlmIChkZWxpbWl0ZXIgJiYgZGVsaW1pdGVyICE9PSAnaW4nKSB7XG4gICAgICAgIGRhdGFLZXkgPSBkZWxpbWl0ZXJcbiAgICB9XG5cbiAgICAvLyBnZXQgdGhlIHNlYXJjaCBzdHJpbmdcbiAgICB2YXIgc2VhcmNoID0gc3RyaXBRdW90ZXMoc2VhcmNoS2V5KSB8fCB0aGlzLiRnZXQoc2VhcmNoS2V5KVxuICAgIGlmICghc2VhcmNoKSByZXR1cm4gYXJyXG4gICAgc2VhcmNoID0gc2VhcmNoLnRvTG93ZXJDYXNlKClcblxuICAgIC8vIGdldCB0aGUgb3B0aW9uYWwgZGF0YUtleVxuICAgIGRhdGFLZXkgPSBkYXRhS2V5ICYmIChzdHJpcFF1b3RlcyhkYXRhS2V5KSB8fCB0aGlzLiRnZXQoZGF0YUtleSkpXG5cbiAgICAvLyBjb252ZXJ0IG9iamVjdCB0byBhcnJheVxuICAgIGlmICghQXJyYXkuaXNBcnJheShhcnIpKSB7XG4gICAgICAgIGFyciA9IHV0aWxzLm9iamVjdFRvQXJyYXkoYXJyKVxuICAgIH1cblxuICAgIHJldHVybiBhcnIuZmlsdGVyKGZ1bmN0aW9uIChpdGVtKSB7XG4gICAgICAgIHJldHVybiBkYXRhS2V5XG4gICAgICAgICAgICA/IGNvbnRhaW5zKGdldChpdGVtLCBkYXRhS2V5KSwgc2VhcmNoKVxuICAgICAgICAgICAgOiBjb250YWlucyhpdGVtLCBzZWFyY2gpXG4gICAgfSlcblxufVxuXG5maWx0ZXJzLmZpbHRlckJ5LmNvbXB1dGVkID0gdHJ1ZVxuXG4vKipcbiAqICBTb3J0IGZpdGxlciBmb3Igdi1yZXBlYXRcbiAqL1xuZmlsdGVycy5vcmRlckJ5ID0gZnVuY3Rpb24gKGFyciwgc29ydEtleSwgcmV2ZXJzZUtleSkge1xuXG4gICAgdmFyIGtleSA9IHN0cmlwUXVvdGVzKHNvcnRLZXkpIHx8IHRoaXMuJGdldChzb3J0S2V5KVxuICAgIGlmICgha2V5KSByZXR1cm4gYXJyXG5cbiAgICAvLyBjb252ZXJ0IG9iamVjdCB0byBhcnJheVxuICAgIGlmICghQXJyYXkuaXNBcnJheShhcnIpKSB7XG4gICAgICAgIGFyciA9IHV0aWxzLm9iamVjdFRvQXJyYXkoYXJyKVxuICAgIH1cblxuICAgIHZhciBvcmRlciA9IDFcbiAgICBpZiAocmV2ZXJzZUtleSkge1xuICAgICAgICBpZiAocmV2ZXJzZUtleSA9PT0gJy0xJykge1xuICAgICAgICAgICAgb3JkZXIgPSAtMVxuICAgICAgICB9IGVsc2UgaWYgKHJldmVyc2VLZXkuY2hhckF0KDApID09PSAnIScpIHtcbiAgICAgICAgICAgIHJldmVyc2VLZXkgPSByZXZlcnNlS2V5LnNsaWNlKDEpXG4gICAgICAgICAgICBvcmRlciA9IHRoaXMuJGdldChyZXZlcnNlS2V5KSA/IDEgOiAtMVxuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgb3JkZXIgPSB0aGlzLiRnZXQocmV2ZXJzZUtleSkgPyAtMSA6IDFcbiAgICAgICAgfVxuICAgIH1cblxuICAgIC8vIHNvcnQgb24gYSBjb3B5IHRvIGF2b2lkIG11dGF0aW5nIG9yaWdpbmFsIGFycmF5XG4gICAgcmV0dXJuIGFyci5zbGljZSgpLnNvcnQoZnVuY3Rpb24gKGEsIGIpIHtcbiAgICAgICAgYSA9IGdldChhLCBrZXkpXG4gICAgICAgIGIgPSBnZXQoYiwga2V5KVxuICAgICAgICByZXR1cm4gYSA9PT0gYiA/IDAgOiBhID4gYiA/IG9yZGVyIDogLW9yZGVyXG4gICAgfSlcblxufVxuXG5maWx0ZXJzLm9yZGVyQnkuY29tcHV0ZWQgPSB0cnVlXG5cbi8vIEFycmF5IGZpbHRlciBoZWxwZXJzIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuLyoqXG4gKiAgU3RyaW5nIGNvbnRhaW4gaGVscGVyXG4gKi9cbmZ1bmN0aW9uIGNvbnRhaW5zICh2YWwsIHNlYXJjaCkge1xuICAgIC8qIGpzaGludCBlcWVxZXE6IGZhbHNlICovXG4gICAgaWYgKHV0aWxzLmlzT2JqZWN0KHZhbCkpIHtcbiAgICAgICAgZm9yICh2YXIga2V5IGluIHZhbCkge1xuICAgICAgICAgICAgaWYgKGNvbnRhaW5zKHZhbFtrZXldLCBzZWFyY2gpKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHRydWVcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgIH0gZWxzZSBpZiAodmFsICE9IG51bGwpIHtcbiAgICAgICAgcmV0dXJuIHZhbC50b1N0cmluZygpLnRvTG93ZXJDYXNlKCkuaW5kZXhPZihzZWFyY2gpID4gLTFcbiAgICB9XG59XG5cbi8qKlxuICogIFRlc3Qgd2hldGhlciBhIHN0cmluZyBpcyBpbiBxdW90ZXMsXG4gKiAgaWYgeWVzIHJldHVybiBzdHJpcHBlZCBzdHJpbmdcbiAqL1xuZnVuY3Rpb24gc3RyaXBRdW90ZXMgKHN0cikge1xuICAgIGlmIChRVU9URV9SRS50ZXN0KHN0cikpIHtcbiAgICAgICAgcmV0dXJuIHN0ci5zbGljZSgxLCAtMSlcbiAgICB9XG59IiwidmFyIGNvbmZpZyAgICAgID0gcmVxdWlyZSgnLi9jb25maWcnKSxcbiAgICBWaWV3TW9kZWwgICA9IHJlcXVpcmUoJy4vdmlld21vZGVsJyksXG4gICAgdXRpbHMgICAgICAgPSByZXF1aXJlKCcuL3V0aWxzJyksXG4gICAgbWFrZUhhc2ggICAgPSB1dGlscy5oYXNoLFxuICAgIGFzc2V0VHlwZXMgID0gWydkaXJlY3RpdmUnLCAnZmlsdGVyJywgJ3BhcnRpYWwnLCAnZWZmZWN0JywgJ2NvbXBvbmVudCddXG5cbi8vIHJlcXVpcmUgdGhlc2Ugc28gQnJvd3NlcmlmeSBjYW4gY2F0Y2ggdGhlbVxuLy8gc28gdGhleSBjYW4gYmUgdXNlZCBpbiBWdWUucmVxdWlyZVxucmVxdWlyZSgnLi9vYnNlcnZlcicpXG5yZXF1aXJlKCcuL3RyYW5zaXRpb24nKVxuXG5WaWV3TW9kZWwub3B0aW9ucyA9IGNvbmZpZy5nbG9iYWxBc3NldHMgPSB7XG4gICAgZGlyZWN0aXZlcyAgOiByZXF1aXJlKCcuL2RpcmVjdGl2ZXMnKSxcbiAgICBmaWx0ZXJzICAgICA6IHJlcXVpcmUoJy4vZmlsdGVycycpLFxuICAgIHBhcnRpYWxzICAgIDogbWFrZUhhc2goKSxcbiAgICBlZmZlY3RzICAgICA6IG1ha2VIYXNoKCksXG4gICAgY29tcG9uZW50cyAgOiBtYWtlSGFzaCgpXG59XG5cbi8qKlxuICogIEV4cG9zZSBhc3NldCByZWdpc3RyYXRpb24gbWV0aG9kc1xuICovXG5hc3NldFR5cGVzLmZvckVhY2goZnVuY3Rpb24gKHR5cGUpIHtcbiAgICBWaWV3TW9kZWxbdHlwZV0gPSBmdW5jdGlvbiAoaWQsIHZhbHVlKSB7XG4gICAgICAgIHZhciBoYXNoID0gdGhpcy5vcHRpb25zW3R5cGUgKyAncyddXG4gICAgICAgIGlmICghaGFzaCkge1xuICAgICAgICAgICAgaGFzaCA9IHRoaXMub3B0aW9uc1t0eXBlICsgJ3MnXSA9IG1ha2VIYXNoKClcbiAgICAgICAgfVxuICAgICAgICBpZiAoIXZhbHVlKSByZXR1cm4gaGFzaFtpZF1cbiAgICAgICAgaWYgKHR5cGUgPT09ICdwYXJ0aWFsJykge1xuICAgICAgICAgICAgdmFsdWUgPSB1dGlscy50b0ZyYWdtZW50KHZhbHVlKVxuICAgICAgICB9IGVsc2UgaWYgKHR5cGUgPT09ICdjb21wb25lbnQnKSB7XG4gICAgICAgICAgICB2YWx1ZSA9IHV0aWxzLnRvQ29uc3RydWN0b3IodmFsdWUpXG4gICAgICAgIH0gZWxzZSBpZiAodHlwZSA9PT0gJ2ZpbHRlcicpIHtcbiAgICAgICAgICAgIHV0aWxzLmNoZWNrRmlsdGVyKHZhbHVlKVxuICAgICAgICB9XG4gICAgICAgIGhhc2hbaWRdID0gdmFsdWVcbiAgICAgICAgcmV0dXJuIHRoaXNcbiAgICB9XG59KVxuXG4vKipcbiAqICBTZXQgY29uZmlnIG9wdGlvbnNcbiAqL1xuVmlld01vZGVsLmNvbmZpZyA9IGZ1bmN0aW9uIChvcHRzLCB2YWwpIHtcbiAgICBpZiAodHlwZW9mIG9wdHMgPT09ICdzdHJpbmcnKSB7XG4gICAgICAgIGlmICh2YWwgPT09IHVuZGVmaW5lZCkge1xuICAgICAgICAgICAgcmV0dXJuIGNvbmZpZ1tvcHRzXVxuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgY29uZmlnW29wdHNdID0gdmFsXG4gICAgICAgIH1cbiAgICB9IGVsc2Uge1xuICAgICAgICB1dGlscy5leHRlbmQoY29uZmlnLCBvcHRzKVxuICAgIH1cbiAgICByZXR1cm4gdGhpc1xufVxuXG4vKipcbiAqICBFeHBvc2UgYW4gaW50ZXJmYWNlIGZvciBwbHVnaW5zXG4gKi9cblZpZXdNb2RlbC51c2UgPSBmdW5jdGlvbiAocGx1Z2luKSB7XG4gICAgaWYgKHR5cGVvZiBwbHVnaW4gPT09ICdzdHJpbmcnKSB7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgICBwbHVnaW4gPSByZXF1aXJlKHBsdWdpbilcbiAgICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICAgICAgdXRpbHMud2FybignQ2Fubm90IGZpbmQgcGx1Z2luOiAnICsgcGx1Z2luKVxuICAgICAgICAgICAgcmV0dXJuXG4gICAgICAgIH1cbiAgICB9XG5cbiAgICAvLyBhZGRpdGlvbmFsIHBhcmFtZXRlcnNcbiAgICB2YXIgYXJncyA9IFtdLnNsaWNlLmNhbGwoYXJndW1lbnRzLCAxKVxuICAgIGFyZ3MudW5zaGlmdCh0aGlzKVxuXG4gICAgaWYgKHR5cGVvZiBwbHVnaW4uaW5zdGFsbCA9PT0gJ2Z1bmN0aW9uJykge1xuICAgICAgICBwbHVnaW4uaW5zdGFsbC5hcHBseShwbHVnaW4sIGFyZ3MpXG4gICAgfSBlbHNlIHtcbiAgICAgICAgcGx1Z2luLmFwcGx5KG51bGwsIGFyZ3MpXG4gICAgfVxuICAgIHJldHVybiB0aGlzXG59XG5cbi8qKlxuICogIEV4cG9zZSBpbnRlcm5hbCBtb2R1bGVzIGZvciBwbHVnaW5zXG4gKi9cblZpZXdNb2RlbC5yZXF1aXJlID0gZnVuY3Rpb24gKHBhdGgpIHtcbiAgICByZXR1cm4gcmVxdWlyZSgnLi8nICsgcGF0aClcbn1cblxuVmlld01vZGVsLmV4dGVuZCA9IGV4dGVuZFxuVmlld01vZGVsLm5leHRUaWNrID0gdXRpbHMubmV4dFRpY2tcblxuLyoqXG4gKiAgRXhwb3NlIHRoZSBtYWluIFZpZXdNb2RlbCBjbGFzc1xuICogIGFuZCBhZGQgZXh0ZW5kIG1ldGhvZFxuICovXG5mdW5jdGlvbiBleHRlbmQgKG9wdGlvbnMpIHtcblxuICAgIHZhciBQYXJlbnRWTSA9IHRoaXNcblxuICAgIC8vIGV4dGVuZCBkYXRhIG9wdGlvbnMgbmVlZCB0byBiZSBjb3BpZWRcbiAgICAvLyBvbiBpbnN0YW50aWF0aW9uXG4gICAgaWYgKG9wdGlvbnMuZGF0YSkge1xuICAgICAgICBvcHRpb25zLmRlZmF1bHREYXRhID0gb3B0aW9ucy5kYXRhXG4gICAgICAgIGRlbGV0ZSBvcHRpb25zLmRhdGFcbiAgICB9XG5cbiAgICAvLyBpbmhlcml0IG9wdGlvbnNcbiAgICBvcHRpb25zID0gaW5oZXJpdE9wdGlvbnMob3B0aW9ucywgUGFyZW50Vk0ub3B0aW9ucywgdHJ1ZSlcbiAgICB1dGlscy5wcm9jZXNzT3B0aW9ucyhvcHRpb25zKVxuXG4gICAgdmFyIEV4dGVuZGVkVk0gPSBmdW5jdGlvbiAob3B0cywgYXNQYXJlbnQpIHtcbiAgICAgICAgaWYgKCFhc1BhcmVudCkge1xuICAgICAgICAgICAgb3B0cyA9IGluaGVyaXRPcHRpb25zKG9wdHMsIG9wdGlvbnMsIHRydWUpXG4gICAgICAgIH1cbiAgICAgICAgUGFyZW50Vk0uY2FsbCh0aGlzLCBvcHRzLCB0cnVlKVxuICAgIH1cblxuICAgIC8vIGluaGVyaXQgcHJvdG90eXBlIHByb3BzXG4gICAgdmFyIHByb3RvID0gRXh0ZW5kZWRWTS5wcm90b3R5cGUgPSBPYmplY3QuY3JlYXRlKFBhcmVudFZNLnByb3RvdHlwZSlcbiAgICB1dGlscy5kZWZQcm90ZWN0ZWQocHJvdG8sICdjb25zdHJ1Y3RvcicsIEV4dGVuZGVkVk0pXG5cbiAgICAvLyBhbGxvdyBleHRlbmRlZCBWTSB0byBiZSBmdXJ0aGVyIGV4dGVuZGVkXG4gICAgRXh0ZW5kZWRWTS5leHRlbmQgID0gZXh0ZW5kXG4gICAgRXh0ZW5kZWRWTS5zdXBlciAgID0gUGFyZW50Vk1cbiAgICBFeHRlbmRlZFZNLm9wdGlvbnMgPSBvcHRpb25zXG5cbiAgICAvLyBhbGxvdyBleHRlbmRlZCBWTSB0byBhZGQgaXRzIG93biBhc3NldHNcbiAgICBhc3NldFR5cGVzLmZvckVhY2goZnVuY3Rpb24gKHR5cGUpIHtcbiAgICAgICAgRXh0ZW5kZWRWTVt0eXBlXSA9IFZpZXdNb2RlbFt0eXBlXVxuICAgIH0pXG5cbiAgICAvLyBhbGxvdyBleHRlbmRlZCBWTSB0byB1c2UgcGx1Z2luc1xuICAgIEV4dGVuZGVkVk0udXNlICAgICA9IFZpZXdNb2RlbC51c2VcbiAgICBFeHRlbmRlZFZNLnJlcXVpcmUgPSBWaWV3TW9kZWwucmVxdWlyZVxuXG4gICAgcmV0dXJuIEV4dGVuZGVkVk1cbn1cblxuLyoqXG4gKiAgSW5oZXJpdCBvcHRpb25zXG4gKlxuICogIEZvciBvcHRpb25zIHN1Y2ggYXMgYGRhdGFgLCBgdm1zYCwgYGRpcmVjdGl2ZXNgLCAncGFydGlhbHMnLFxuICogIHRoZXkgc2hvdWxkIGJlIGZ1cnRoZXIgZXh0ZW5kZWQuIEhvd2V2ZXIgZXh0ZW5kaW5nIHNob3VsZCBvbmx5XG4gKiAgYmUgZG9uZSBhdCB0b3AgbGV2ZWwuXG4gKiAgXG4gKiAgYHByb3RvYCBpcyBhbiBleGNlcHRpb24gYmVjYXVzZSBpdCdzIGhhbmRsZWQgZGlyZWN0bHkgb24gdGhlXG4gKiAgcHJvdG90eXBlLlxuICpcbiAqICBgZWxgIGlzIGFuIGV4Y2VwdGlvbiBiZWNhdXNlIGl0J3Mgbm90IGFsbG93ZWQgYXMgYW5cbiAqICBleHRlbnNpb24gb3B0aW9uLCBidXQgb25seSBhcyBhbiBpbnN0YW5jZSBvcHRpb24uXG4gKi9cbmZ1bmN0aW9uIGluaGVyaXRPcHRpb25zIChjaGlsZCwgcGFyZW50LCB0b3BMZXZlbCkge1xuICAgIGNoaWxkID0gY2hpbGQgfHwge31cbiAgICBpZiAoIXBhcmVudCkgcmV0dXJuIGNoaWxkXG4gICAgZm9yICh2YXIga2V5IGluIHBhcmVudCkge1xuICAgICAgICBpZiAoa2V5ID09PSAnZWwnKSBjb250aW51ZVxuICAgICAgICB2YXIgdmFsID0gY2hpbGRba2V5XSxcbiAgICAgICAgICAgIHBhcmVudFZhbCA9IHBhcmVudFtrZXldXG4gICAgICAgIGlmICh0b3BMZXZlbCAmJiB0eXBlb2YgdmFsID09PSAnZnVuY3Rpb24nICYmIHBhcmVudFZhbCkge1xuICAgICAgICAgICAgLy8gbWVyZ2UgaG9vayBmdW5jdGlvbnMgaW50byBhbiBhcnJheVxuICAgICAgICAgICAgY2hpbGRba2V5XSA9IFt2YWxdXG4gICAgICAgICAgICBpZiAoQXJyYXkuaXNBcnJheShwYXJlbnRWYWwpKSB7XG4gICAgICAgICAgICAgICAgY2hpbGRba2V5XSA9IGNoaWxkW2tleV0uY29uY2F0KHBhcmVudFZhbClcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgY2hpbGRba2V5XS5wdXNoKHBhcmVudFZhbClcbiAgICAgICAgICAgIH1cbiAgICAgICAgfSBlbHNlIGlmIChcbiAgICAgICAgICAgIHRvcExldmVsICYmXG4gICAgICAgICAgICAodXRpbHMuaXNUcnVlT2JqZWN0KHZhbCkgfHwgdXRpbHMuaXNUcnVlT2JqZWN0KHBhcmVudFZhbCkpXG4gICAgICAgICAgICAmJiAhKHBhcmVudFZhbCBpbnN0YW5jZW9mIFZpZXdNb2RlbClcbiAgICAgICAgKSB7XG4gICAgICAgICAgICAvLyBtZXJnZSB0b3BsZXZlbCBvYmplY3Qgb3B0aW9uc1xuICAgICAgICAgICAgY2hpbGRba2V5XSA9IGluaGVyaXRPcHRpb25zKHZhbCwgcGFyZW50VmFsKVxuICAgICAgICB9IGVsc2UgaWYgKHZhbCA9PT0gdW5kZWZpbmVkKSB7XG4gICAgICAgICAgICAvLyBpbmhlcml0IGlmIGNoaWxkIGRvZXNuJ3Qgb3ZlcnJpZGVcbiAgICAgICAgICAgIGNoaWxkW2tleV0gPSBwYXJlbnRWYWxcbiAgICAgICAgfVxuICAgIH1cbiAgICByZXR1cm4gY2hpbGRcbn1cblxubW9kdWxlLmV4cG9ydHMgPSBWaWV3TW9kZWwiLCIvKiBqc2hpbnQgcHJvdG86dHJ1ZSAqL1xuXG52YXIgRW1pdHRlciAgPSByZXF1aXJlKCcuL2VtaXR0ZXInKSxcbiAgICB1dGlscyAgICA9IHJlcXVpcmUoJy4vdXRpbHMnKSxcbiAgICAvLyBjYWNoZSBtZXRob2RzXG4gICAgZGVmICAgICAgPSB1dGlscy5kZWZQcm90ZWN0ZWQsXG4gICAgaXNPYmplY3QgPSB1dGlscy5pc09iamVjdCxcbiAgICBpc0FycmF5ICA9IEFycmF5LmlzQXJyYXksXG4gICAgaGFzT3duICAgPSAoe30pLmhhc093blByb3BlcnR5LFxuICAgIG9EZWYgICAgID0gT2JqZWN0LmRlZmluZVByb3BlcnR5LFxuICAgIHNsaWNlICAgID0gW10uc2xpY2UsXG4gICAgLy8gZml4IGZvciBJRSArIF9fcHJvdG9fXyBwcm9ibGVtXG4gICAgLy8gZGVmaW5lIG1ldGhvZHMgYXMgaW5lbnVtZXJhYmxlIGlmIF9fcHJvdG9fXyBpcyBwcmVzZW50LFxuICAgIC8vIG90aGVyd2lzZSBlbnVtZXJhYmxlIHNvIHdlIGNhbiBsb29wIHRocm91Z2ggYW5kIG1hbnVhbGx5XG4gICAgLy8gYXR0YWNoIHRvIGFycmF5IGluc3RhbmNlc1xuICAgIGhhc1Byb3RvID0gKHt9KS5fX3Byb3RvX19cblxuLy8gQXJyYXkgTXV0YXRpb24gSGFuZGxlcnMgJiBBdWdtZW50YXRpb25zIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXG4vLyBUaGUgcHJveHkgcHJvdG90eXBlIHRvIHJlcGxhY2UgdGhlIF9fcHJvdG9fXyBvZlxuLy8gYW4gb2JzZXJ2ZWQgYXJyYXlcbnZhciBBcnJheVByb3h5ID0gT2JqZWN0LmNyZWF0ZShBcnJheS5wcm90b3R5cGUpXG5cbi8vIGludGVyY2VwdCBtdXRhdGlvbiBtZXRob2RzXG47W1xuICAgICdwdXNoJyxcbiAgICAncG9wJyxcbiAgICAnc2hpZnQnLFxuICAgICd1bnNoaWZ0JyxcbiAgICAnc3BsaWNlJyxcbiAgICAnc29ydCcsXG4gICAgJ3JldmVyc2UnXG5dLmZvckVhY2god2F0Y2hNdXRhdGlvbilcblxuLy8gQXVnbWVudCB0aGUgQXJyYXlQcm94eSB3aXRoIGNvbnZlbmllbmNlIG1ldGhvZHNcbmRlZihBcnJheVByb3h5LCAnJHNldCcsIGZ1bmN0aW9uIChpbmRleCwgZGF0YSkge1xuICAgIHJldHVybiB0aGlzLnNwbGljZShpbmRleCwgMSwgZGF0YSlbMF1cbn0sICFoYXNQcm90bylcblxuZGVmKEFycmF5UHJveHksICckcmVtb3ZlJywgZnVuY3Rpb24gKGluZGV4KSB7XG4gICAgaWYgKHR5cGVvZiBpbmRleCAhPT0gJ251bWJlcicpIHtcbiAgICAgICAgaW5kZXggPSB0aGlzLmluZGV4T2YoaW5kZXgpXG4gICAgfVxuICAgIGlmIChpbmRleCA+IC0xKSB7XG4gICAgICAgIHJldHVybiB0aGlzLnNwbGljZShpbmRleCwgMSlbMF1cbiAgICB9XG59LCAhaGFzUHJvdG8pXG5cbi8qKlxuICogIEludGVyY2VwIGEgbXV0YXRpb24gZXZlbnQgc28gd2UgY2FuIGVtaXQgdGhlIG11dGF0aW9uIGluZm8uXG4gKiAgd2UgYWxzbyBhbmFseXplIHdoYXQgZWxlbWVudHMgYXJlIGFkZGVkL3JlbW92ZWQgYW5kIGxpbmsvdW5saW5rXG4gKiAgdGhlbSB3aXRoIHRoZSBwYXJlbnQgQXJyYXkuXG4gKi9cbmZ1bmN0aW9uIHdhdGNoTXV0YXRpb24gKG1ldGhvZCkge1xuICAgIGRlZihBcnJheVByb3h5LCBtZXRob2QsIGZ1bmN0aW9uICgpIHtcblxuICAgICAgICB2YXIgYXJncyA9IHNsaWNlLmNhbGwoYXJndW1lbnRzKSxcbiAgICAgICAgICAgIHJlc3VsdCA9IEFycmF5LnByb3RvdHlwZVttZXRob2RdLmFwcGx5KHRoaXMsIGFyZ3MpLFxuICAgICAgICAgICAgaW5zZXJ0ZWQsIHJlbW92ZWRcblxuICAgICAgICAvLyBkZXRlcm1pbmUgbmV3IC8gcmVtb3ZlZCBlbGVtZW50c1xuICAgICAgICBpZiAobWV0aG9kID09PSAncHVzaCcgfHwgbWV0aG9kID09PSAndW5zaGlmdCcpIHtcbiAgICAgICAgICAgIGluc2VydGVkID0gYXJnc1xuICAgICAgICB9IGVsc2UgaWYgKG1ldGhvZCA9PT0gJ3BvcCcgfHwgbWV0aG9kID09PSAnc2hpZnQnKSB7XG4gICAgICAgICAgICByZW1vdmVkID0gW3Jlc3VsdF1cbiAgICAgICAgfSBlbHNlIGlmIChtZXRob2QgPT09ICdzcGxpY2UnKSB7XG4gICAgICAgICAgICBpbnNlcnRlZCA9IGFyZ3Muc2xpY2UoMilcbiAgICAgICAgICAgIHJlbW92ZWQgPSByZXN1bHRcbiAgICAgICAgfVxuICAgICAgICBcbiAgICAgICAgLy8gbGluayAmIHVubGlua1xuICAgICAgICBsaW5rQXJyYXlFbGVtZW50cyh0aGlzLCBpbnNlcnRlZClcbiAgICAgICAgdW5saW5rQXJyYXlFbGVtZW50cyh0aGlzLCByZW1vdmVkKVxuXG4gICAgICAgIC8vIGVtaXQgdGhlIG11dGF0aW9uIGV2ZW50XG4gICAgICAgIHRoaXMuX19lbWl0dGVyX18uZW1pdCgnbXV0YXRlJywgJycsIHRoaXMsIHtcbiAgICAgICAgICAgIG1ldGhvZCAgIDogbWV0aG9kLFxuICAgICAgICAgICAgYXJncyAgICAgOiBhcmdzLFxuICAgICAgICAgICAgcmVzdWx0ICAgOiByZXN1bHQsXG4gICAgICAgICAgICBpbnNlcnRlZCA6IGluc2VydGVkLFxuICAgICAgICAgICAgcmVtb3ZlZCAgOiByZW1vdmVkXG4gICAgICAgIH0pXG5cbiAgICAgICAgcmV0dXJuIHJlc3VsdFxuICAgICAgICBcbiAgICB9LCAhaGFzUHJvdG8pXG59XG5cbi8qKlxuICogIExpbmsgbmV3IGVsZW1lbnRzIHRvIGFuIEFycmF5LCBzbyB3aGVuIHRoZXkgY2hhbmdlXG4gKiAgYW5kIGVtaXQgZXZlbnRzLCB0aGUgb3duZXIgQXJyYXkgY2FuIGJlIG5vdGlmaWVkLlxuICovXG5mdW5jdGlvbiBsaW5rQXJyYXlFbGVtZW50cyAoYXJyLCBpdGVtcykge1xuICAgIGlmIChpdGVtcykge1xuICAgICAgICB2YXIgaSA9IGl0ZW1zLmxlbmd0aCwgaXRlbSwgb3duZXJzXG4gICAgICAgIHdoaWxlIChpLS0pIHtcbiAgICAgICAgICAgIGl0ZW0gPSBpdGVtc1tpXVxuICAgICAgICAgICAgaWYgKGlzV2F0Y2hhYmxlKGl0ZW0pKSB7XG4gICAgICAgICAgICAgICAgLy8gaWYgb2JqZWN0IGlzIG5vdCBjb252ZXJ0ZWQgZm9yIG9ic2VydmluZ1xuICAgICAgICAgICAgICAgIC8vIGNvbnZlcnQgaXQuLi5cbiAgICAgICAgICAgICAgICBpZiAoIWl0ZW0uX19lbWl0dGVyX18pIHtcbiAgICAgICAgICAgICAgICAgICAgY29udmVydChpdGVtKVxuICAgICAgICAgICAgICAgICAgICB3YXRjaChpdGVtKVxuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBvd25lcnMgPSBpdGVtLl9fZW1pdHRlcl9fLm93bmVyc1xuICAgICAgICAgICAgICAgIGlmIChvd25lcnMuaW5kZXhPZihhcnIpIDwgMCkge1xuICAgICAgICAgICAgICAgICAgICBvd25lcnMucHVzaChhcnIpXG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuICAgICAgICB9XG4gICAgfVxufVxuXG4vKipcbiAqICBVbmxpbmsgcmVtb3ZlZCBlbGVtZW50cyBmcm9tIHRoZSBleC1vd25lciBBcnJheS5cbiAqL1xuZnVuY3Rpb24gdW5saW5rQXJyYXlFbGVtZW50cyAoYXJyLCBpdGVtcykge1xuICAgIGlmIChpdGVtcykge1xuICAgICAgICB2YXIgaSA9IGl0ZW1zLmxlbmd0aCwgaXRlbVxuICAgICAgICB3aGlsZSAoaS0tKSB7XG4gICAgICAgICAgICBpdGVtID0gaXRlbXNbaV1cbiAgICAgICAgICAgIGlmIChpdGVtICYmIGl0ZW0uX19lbWl0dGVyX18pIHtcbiAgICAgICAgICAgICAgICB2YXIgb3duZXJzID0gaXRlbS5fX2VtaXR0ZXJfXy5vd25lcnNcbiAgICAgICAgICAgICAgICBpZiAob3duZXJzKSBvd25lcnMuc3BsaWNlKG93bmVycy5pbmRleE9mKGFycikpXG4gICAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICB9XG59XG5cbi8vIE9iamVjdCBhZGQvZGVsZXRlIGtleSBhdWdtZW50YXRpb24gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxudmFyIE9ialByb3h5ID0gT2JqZWN0LmNyZWF0ZShPYmplY3QucHJvdG90eXBlKVxuXG5kZWYoT2JqUHJveHksICckYWRkJywgZnVuY3Rpb24gKGtleSwgdmFsKSB7XG4gICAgaWYgKGhhc093bi5jYWxsKHRoaXMsIGtleSkpIHJldHVyblxuICAgIHRoaXNba2V5XSA9IHZhbFxuICAgIGNvbnZlcnRLZXkodGhpcywga2V5KVxuICAgIC8vIGVtaXQgYSBwcm9wYWdhdGluZyBzZXQgZXZlbnRcbiAgICB0aGlzLl9fZW1pdHRlcl9fLmVtaXQoJ3NldCcsIGtleSwgdmFsLCB0cnVlKVxufSwgIWhhc1Byb3RvKVxuXG5kZWYoT2JqUHJveHksICckZGVsZXRlJywgZnVuY3Rpb24gKGtleSkge1xuICAgIGlmICghKGhhc093bi5jYWxsKHRoaXMsIGtleSkpKSByZXR1cm5cbiAgICAvLyB0cmlnZ2VyIHNldCBldmVudHNcbiAgICB0aGlzW2tleV0gPSB1bmRlZmluZWRcbiAgICBkZWxldGUgdGhpc1trZXldXG4gICAgdGhpcy5fX2VtaXR0ZXJfXy5lbWl0KCdkZWxldGUnLCBrZXkpXG59LCAhaGFzUHJvdG8pXG5cbi8vIFdhdGNoIEhlbHBlcnMgLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuLyoqXG4gKiAgQ2hlY2sgaWYgYSB2YWx1ZSBpcyB3YXRjaGFibGVcbiAqL1xuZnVuY3Rpb24gaXNXYXRjaGFibGUgKG9iaikge1xuICAgIHJldHVybiB0eXBlb2Ygb2JqID09PSAnb2JqZWN0JyAmJiBvYmogJiYgIW9iai4kY29tcGlsZXJcbn1cblxuLyoqXG4gKiAgQ29udmVydCBhbiBPYmplY3QvQXJyYXkgdG8gZ2l2ZSBpdCBhIGNoYW5nZSBlbWl0dGVyLlxuICovXG5mdW5jdGlvbiBjb252ZXJ0IChvYmopIHtcbiAgICBpZiAob2JqLl9fZW1pdHRlcl9fKSByZXR1cm4gdHJ1ZVxuICAgIHZhciBlbWl0dGVyID0gbmV3IEVtaXR0ZXIoKVxuICAgIGRlZihvYmosICdfX2VtaXR0ZXJfXycsIGVtaXR0ZXIpXG4gICAgZW1pdHRlclxuICAgICAgICAub24oJ3NldCcsIGZ1bmN0aW9uIChrZXksIHZhbCwgcHJvcGFnYXRlKSB7XG4gICAgICAgICAgICBpZiAocHJvcGFnYXRlKSBwcm9wYWdhdGVDaGFuZ2Uob2JqKVxuICAgICAgICB9KVxuICAgICAgICAub24oJ211dGF0ZScsIGZ1bmN0aW9uICgpIHtcbiAgICAgICAgICAgIHByb3BhZ2F0ZUNoYW5nZShvYmopXG4gICAgICAgIH0pXG4gICAgZW1pdHRlci52YWx1ZXMgPSB1dGlscy5oYXNoKClcbiAgICBlbWl0dGVyLm93bmVycyA9IFtdXG4gICAgcmV0dXJuIGZhbHNlXG59XG5cbi8qKlxuICogIFByb3BhZ2F0ZSBhbiBhcnJheSBlbGVtZW50J3MgY2hhbmdlIHRvIGl0cyBvd25lciBhcnJheXNcbiAqL1xuZnVuY3Rpb24gcHJvcGFnYXRlQ2hhbmdlIChvYmopIHtcbiAgICB2YXIgb3duZXJzID0gb2JqLl9fZW1pdHRlcl9fLm93bmVycyxcbiAgICAgICAgaSA9IG93bmVycy5sZW5ndGhcbiAgICB3aGlsZSAoaS0tKSB7XG4gICAgICAgIG93bmVyc1tpXS5fX2VtaXR0ZXJfXy5lbWl0KCdzZXQnLCAnJywgJycsIHRydWUpXG4gICAgfVxufVxuXG4vKipcbiAqICBXYXRjaCB0YXJnZXQgYmFzZWQgb24gaXRzIHR5cGVcbiAqL1xuZnVuY3Rpb24gd2F0Y2ggKG9iaikge1xuICAgIGlmIChpc0FycmF5KG9iaikpIHtcbiAgICAgICAgd2F0Y2hBcnJheShvYmopXG4gICAgfSBlbHNlIHtcbiAgICAgICAgd2F0Y2hPYmplY3Qob2JqKVxuICAgIH1cbn1cblxuLyoqXG4gKiAgQXVnbWVudCB0YXJnZXQgb2JqZWN0cyB3aXRoIG1vZGlmaWVkXG4gKiAgbWV0aG9kc1xuICovXG5mdW5jdGlvbiBhdWdtZW50ICh0YXJnZXQsIHNyYykge1xuICAgIGlmIChoYXNQcm90bykge1xuICAgICAgICB0YXJnZXQuX19wcm90b19fID0gc3JjXG4gICAgfSBlbHNlIHtcbiAgICAgICAgZm9yICh2YXIga2V5IGluIHNyYykge1xuICAgICAgICAgICAgZGVmKHRhcmdldCwga2V5LCBzcmNba2V5XSlcbiAgICAgICAgfVxuICAgIH1cbn1cblxuLyoqXG4gKiAgV2F0Y2ggYW4gT2JqZWN0LCByZWN1cnNpdmUuXG4gKi9cbmZ1bmN0aW9uIHdhdGNoT2JqZWN0IChvYmopIHtcbiAgICBhdWdtZW50KG9iaiwgT2JqUHJveHkpXG4gICAgZm9yICh2YXIga2V5IGluIG9iaikge1xuICAgICAgICBjb252ZXJ0S2V5KG9iaiwga2V5KVxuICAgIH1cbn1cblxuLyoqXG4gKiAgV2F0Y2ggYW4gQXJyYXksIG92ZXJsb2FkIG11dGF0aW9uIG1ldGhvZHNcbiAqICBhbmQgYWRkIGF1Z21lbnRhdGlvbnMgYnkgaW50ZXJjZXB0aW5nIHRoZSBwcm90b3R5cGUgY2hhaW5cbiAqL1xuZnVuY3Rpb24gd2F0Y2hBcnJheSAoYXJyKSB7XG4gICAgYXVnbWVudChhcnIsIEFycmF5UHJveHkpXG4gICAgbGlua0FycmF5RWxlbWVudHMoYXJyLCBhcnIpXG59XG5cbi8qKlxuICogIERlZmluZSBhY2Nlc3NvcnMgZm9yIGEgcHJvcGVydHkgb24gYW4gT2JqZWN0XG4gKiAgc28gaXQgZW1pdHMgZ2V0L3NldCBldmVudHMuXG4gKiAgVGhlbiB3YXRjaCB0aGUgdmFsdWUgaXRzZWxmLlxuICovXG5mdW5jdGlvbiBjb252ZXJ0S2V5IChvYmosIGtleSkge1xuICAgIHZhciBrZXlQcmVmaXggPSBrZXkuY2hhckF0KDApXG4gICAgaWYgKGtleVByZWZpeCA9PT0gJyQnIHx8IGtleVByZWZpeCA9PT0gJ18nKSB7XG4gICAgICAgIHJldHVyblxuICAgIH1cbiAgICAvLyBlbWl0IHNldCBvbiBiaW5kXG4gICAgLy8gdGhpcyBtZWFucyB3aGVuIGFuIG9iamVjdCBpcyBvYnNlcnZlZCBpdCB3aWxsIGVtaXRcbiAgICAvLyBhIGZpcnN0IGJhdGNoIG9mIHNldCBldmVudHMuXG4gICAgdmFyIGVtaXR0ZXIgPSBvYmouX19lbWl0dGVyX18sXG4gICAgICAgIHZhbHVlcyAgPSBlbWl0dGVyLnZhbHVlc1xuXG4gICAgaW5pdChvYmpba2V5XSlcblxuICAgIG9EZWYob2JqLCBrZXksIHtcbiAgICAgICAgZW51bWVyYWJsZTogdHJ1ZSxcbiAgICAgICAgY29uZmlndXJhYmxlOiB0cnVlLFxuICAgICAgICBnZXQ6IGZ1bmN0aW9uICgpIHtcbiAgICAgICAgICAgIHZhciB2YWx1ZSA9IHZhbHVlc1trZXldXG4gICAgICAgICAgICAvLyBvbmx5IGVtaXQgZ2V0IG9uIHRpcCB2YWx1ZXNcbiAgICAgICAgICAgIGlmIChwdWIuc2hvdWxkR2V0KSB7XG4gICAgICAgICAgICAgICAgZW1pdHRlci5lbWl0KCdnZXQnLCBrZXkpXG4gICAgICAgICAgICB9XG4gICAgICAgICAgICByZXR1cm4gdmFsdWVcbiAgICAgICAgfSxcbiAgICAgICAgc2V0OiBmdW5jdGlvbiAobmV3VmFsKSB7XG4gICAgICAgICAgICB2YXIgb2xkVmFsID0gdmFsdWVzW2tleV1cbiAgICAgICAgICAgIHVub2JzZXJ2ZShvbGRWYWwsIGtleSwgZW1pdHRlcilcbiAgICAgICAgICAgIGNvcHlQYXRocyhuZXdWYWwsIG9sZFZhbClcbiAgICAgICAgICAgIC8vIGFuIGltbWVkaWF0ZSBwcm9wZXJ0eSBzaG91bGQgbm90aWZ5IGl0cyBwYXJlbnRcbiAgICAgICAgICAgIC8vIHRvIGVtaXQgc2V0IGZvciBpdHNlbGYgdG9vXG4gICAgICAgICAgICBpbml0KG5ld1ZhbCwgdHJ1ZSlcbiAgICAgICAgfVxuICAgIH0pXG5cbiAgICBmdW5jdGlvbiBpbml0ICh2YWwsIHByb3BhZ2F0ZSkge1xuICAgICAgICB2YWx1ZXNba2V5XSA9IHZhbFxuICAgICAgICBlbWl0dGVyLmVtaXQoJ3NldCcsIGtleSwgdmFsLCBwcm9wYWdhdGUpXG4gICAgICAgIGlmIChpc0FycmF5KHZhbCkpIHtcbiAgICAgICAgICAgIGVtaXR0ZXIuZW1pdCgnc2V0Jywga2V5ICsgJy5sZW5ndGgnLCB2YWwubGVuZ3RoLCBwcm9wYWdhdGUpXG4gICAgICAgIH1cbiAgICAgICAgb2JzZXJ2ZSh2YWwsIGtleSwgZW1pdHRlcilcbiAgICB9XG59XG5cbi8qKlxuICogIFdoZW4gYSB2YWx1ZSB0aGF0IGlzIGFscmVhZHkgY29udmVydGVkIGlzXG4gKiAgb2JzZXJ2ZWQgYWdhaW4gYnkgYW5vdGhlciBvYnNlcnZlciwgd2UgY2FuIHNraXBcbiAqICB0aGUgd2F0Y2ggY29udmVyc2lvbiBhbmQgc2ltcGx5IGVtaXQgc2V0IGV2ZW50IGZvclxuICogIGFsbCBvZiBpdHMgcHJvcGVydGllcy5cbiAqL1xuZnVuY3Rpb24gZW1pdFNldCAob2JqKSB7XG4gICAgdmFyIGVtaXR0ZXIgPSBvYmogJiYgb2JqLl9fZW1pdHRlcl9fXG4gICAgaWYgKCFlbWl0dGVyKSByZXR1cm5cbiAgICBpZiAoaXNBcnJheShvYmopKSB7XG4gICAgICAgIGVtaXR0ZXIuZW1pdCgnc2V0JywgJ2xlbmd0aCcsIG9iai5sZW5ndGgpXG4gICAgfSBlbHNlIHtcbiAgICAgICAgdmFyIGtleSwgdmFsXG4gICAgICAgIGZvciAoa2V5IGluIG9iaikge1xuICAgICAgICAgICAgdmFsID0gb2JqW2tleV1cbiAgICAgICAgICAgIGVtaXR0ZXIuZW1pdCgnc2V0Jywga2V5LCB2YWwpXG4gICAgICAgICAgICBlbWl0U2V0KHZhbClcbiAgICAgICAgfVxuICAgIH1cbn1cblxuLyoqXG4gKiAgTWFrZSBzdXJlIGFsbCB0aGUgcGF0aHMgaW4gYW4gb2xkIG9iamVjdCBleGlzdHNcbiAqICBpbiBhIG5ldyBvYmplY3QuXG4gKiAgU28gd2hlbiBhbiBvYmplY3QgY2hhbmdlcywgYWxsIG1pc3Npbmcga2V5cyB3aWxsXG4gKiAgZW1pdCBhIHNldCBldmVudCB3aXRoIHVuZGVmaW5lZCB2YWx1ZS5cbiAqL1xuZnVuY3Rpb24gY29weVBhdGhzIChuZXdPYmosIG9sZE9iaikge1xuICAgIGlmICghaXNPYmplY3QobmV3T2JqKSB8fCAhaXNPYmplY3Qob2xkT2JqKSkge1xuICAgICAgICByZXR1cm5cbiAgICB9XG4gICAgdmFyIHBhdGgsIG9sZFZhbCwgbmV3VmFsXG4gICAgZm9yIChwYXRoIGluIG9sZE9iaikge1xuICAgICAgICBpZiAoIShoYXNPd24uY2FsbChuZXdPYmosIHBhdGgpKSkge1xuICAgICAgICAgICAgb2xkVmFsID0gb2xkT2JqW3BhdGhdXG4gICAgICAgICAgICBpZiAoaXNBcnJheShvbGRWYWwpKSB7XG4gICAgICAgICAgICAgICAgbmV3T2JqW3BhdGhdID0gW11cbiAgICAgICAgICAgIH0gZWxzZSBpZiAoaXNPYmplY3Qob2xkVmFsKSkge1xuICAgICAgICAgICAgICAgIG5ld1ZhbCA9IG5ld09ialtwYXRoXSA9IHt9XG4gICAgICAgICAgICAgICAgY29weVBhdGhzKG5ld1ZhbCwgb2xkVmFsKVxuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICBuZXdPYmpbcGF0aF0gPSB1bmRlZmluZWRcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgIH1cbn1cblxuLyoqXG4gKiAgd2FsayBhbG9uZyBhIHBhdGggYW5kIG1ha2Ugc3VyZSBpdCBjYW4gYmUgYWNjZXNzZWRcbiAqICBhbmQgZW51bWVyYXRlZCBpbiB0aGF0IG9iamVjdFxuICovXG5mdW5jdGlvbiBlbnN1cmVQYXRoIChvYmosIGtleSkge1xuICAgIHZhciBwYXRoID0ga2V5LnNwbGl0KCcuJyksIHNlY1xuICAgIGZvciAodmFyIGkgPSAwLCBkID0gcGF0aC5sZW5ndGggLSAxOyBpIDwgZDsgaSsrKSB7XG4gICAgICAgIHNlYyA9IHBhdGhbaV1cbiAgICAgICAgaWYgKCFvYmpbc2VjXSkge1xuICAgICAgICAgICAgb2JqW3NlY10gPSB7fVxuICAgICAgICAgICAgaWYgKG9iai5fX2VtaXR0ZXJfXykgY29udmVydEtleShvYmosIHNlYylcbiAgICAgICAgfVxuICAgICAgICBvYmogPSBvYmpbc2VjXVxuICAgIH1cbiAgICBpZiAoaXNPYmplY3Qob2JqKSkge1xuICAgICAgICBzZWMgPSBwYXRoW2ldXG4gICAgICAgIGlmICghKGhhc093bi5jYWxsKG9iaiwgc2VjKSkpIHtcbiAgICAgICAgICAgIG9ialtzZWNdID0gdW5kZWZpbmVkXG4gICAgICAgICAgICBpZiAob2JqLl9fZW1pdHRlcl9fKSBjb252ZXJ0S2V5KG9iaiwgc2VjKVxuICAgICAgICB9XG4gICAgfVxufVxuXG4vLyBNYWluIEFQSSBNZXRob2RzIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbi8qKlxuICogIE9ic2VydmUgYW4gb2JqZWN0IHdpdGggYSBnaXZlbiBwYXRoLFxuICogIGFuZCBwcm94eSBnZXQvc2V0L211dGF0ZSBldmVudHMgdG8gdGhlIHByb3ZpZGVkIG9ic2VydmVyLlxuICovXG5mdW5jdGlvbiBvYnNlcnZlIChvYmosIHJhd1BhdGgsIG9ic2VydmVyKSB7XG5cbiAgICBpZiAoIWlzV2F0Y2hhYmxlKG9iaikpIHJldHVyblxuXG4gICAgdmFyIHBhdGggPSByYXdQYXRoID8gcmF3UGF0aCArICcuJyA6ICcnLFxuICAgICAgICBhbHJlYWR5Q29udmVydGVkID0gY29udmVydChvYmopLFxuICAgICAgICBlbWl0dGVyID0gb2JqLl9fZW1pdHRlcl9fXG5cbiAgICAvLyBzZXR1cCBwcm94eSBsaXN0ZW5lcnMgb24gdGhlIHBhcmVudCBvYnNlcnZlci5cbiAgICAvLyB3ZSBuZWVkIHRvIGtlZXAgcmVmZXJlbmNlIHRvIHRoZW0gc28gdGhhdCB0aGV5XG4gICAgLy8gY2FuIGJlIHJlbW92ZWQgd2hlbiB0aGUgb2JqZWN0IGlzIHVuLW9ic2VydmVkLlxuICAgIG9ic2VydmVyLnByb3hpZXMgPSBvYnNlcnZlci5wcm94aWVzIHx8IHt9XG4gICAgdmFyIHByb3hpZXMgPSBvYnNlcnZlci5wcm94aWVzW3BhdGhdID0ge1xuICAgICAgICBnZXQ6IGZ1bmN0aW9uIChrZXkpIHtcbiAgICAgICAgICAgIG9ic2VydmVyLmVtaXQoJ2dldCcsIHBhdGggKyBrZXkpXG4gICAgICAgIH0sXG4gICAgICAgIHNldDogZnVuY3Rpb24gKGtleSwgdmFsLCBwcm9wYWdhdGUpIHtcbiAgICAgICAgICAgIGlmIChrZXkpIG9ic2VydmVyLmVtaXQoJ3NldCcsIHBhdGggKyBrZXksIHZhbClcbiAgICAgICAgICAgIC8vIGFsc28gbm90aWZ5IG9ic2VydmVyIHRoYXQgdGhlIG9iamVjdCBpdHNlbGYgY2hhbmdlZFxuICAgICAgICAgICAgLy8gYnV0IG9ubHkgZG8gc28gd2hlbiBpdCdzIGEgaW1tZWRpYXRlIHByb3BlcnR5LiB0aGlzXG4gICAgICAgICAgICAvLyBhdm9pZHMgZHVwbGljYXRlIGV2ZW50IGZpcmluZy5cbiAgICAgICAgICAgIGlmIChyYXdQYXRoICYmIHByb3BhZ2F0ZSkge1xuICAgICAgICAgICAgICAgIG9ic2VydmVyLmVtaXQoJ3NldCcsIHJhd1BhdGgsIG9iaiwgdHJ1ZSlcbiAgICAgICAgICAgIH1cbiAgICAgICAgfSxcbiAgICAgICAgbXV0YXRlOiBmdW5jdGlvbiAoa2V5LCB2YWwsIG11dGF0aW9uKSB7XG4gICAgICAgICAgICAvLyBpZiB0aGUgQXJyYXkgaXMgYSByb290IHZhbHVlXG4gICAgICAgICAgICAvLyB0aGUga2V5IHdpbGwgYmUgbnVsbFxuICAgICAgICAgICAgdmFyIGZpeGVkUGF0aCA9IGtleSA/IHBhdGggKyBrZXkgOiByYXdQYXRoXG4gICAgICAgICAgICBvYnNlcnZlci5lbWl0KCdtdXRhdGUnLCBmaXhlZFBhdGgsIHZhbCwgbXV0YXRpb24pXG4gICAgICAgICAgICAvLyBhbHNvIGVtaXQgc2V0IGZvciBBcnJheSdzIGxlbmd0aCB3aGVuIGl0IG11dGF0ZXNcbiAgICAgICAgICAgIHZhciBtID0gbXV0YXRpb24ubWV0aG9kXG4gICAgICAgICAgICBpZiAobSAhPT0gJ3NvcnQnICYmIG0gIT09ICdyZXZlcnNlJykge1xuICAgICAgICAgICAgICAgIG9ic2VydmVyLmVtaXQoJ3NldCcsIGZpeGVkUGF0aCArICcubGVuZ3RoJywgdmFsLmxlbmd0aClcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgIH1cblxuICAgIC8vIGF0dGFjaCB0aGUgbGlzdGVuZXJzIHRvIHRoZSBjaGlsZCBvYnNlcnZlci5cbiAgICAvLyBub3cgYWxsIHRoZSBldmVudHMgd2lsbCBwcm9wYWdhdGUgdXB3YXJkcy5cbiAgICBlbWl0dGVyXG4gICAgICAgIC5vbignZ2V0JywgcHJveGllcy5nZXQpXG4gICAgICAgIC5vbignc2V0JywgcHJveGllcy5zZXQpXG4gICAgICAgIC5vbignbXV0YXRlJywgcHJveGllcy5tdXRhdGUpXG5cbiAgICBpZiAoYWxyZWFkeUNvbnZlcnRlZCkge1xuICAgICAgICAvLyBmb3Igb2JqZWN0cyB0aGF0IGhhdmUgYWxyZWFkeSBiZWVuIGNvbnZlcnRlZCxcbiAgICAgICAgLy8gZW1pdCBzZXQgZXZlbnRzIGZvciBldmVyeXRoaW5nIGluc2lkZVxuICAgICAgICBlbWl0U2V0KG9iailcbiAgICB9IGVsc2Uge1xuICAgICAgICB3YXRjaChvYmopXG4gICAgfVxufVxuXG4vKipcbiAqICBDYW5jZWwgb2JzZXJ2YXRpb24sIHR1cm4gb2ZmIHRoZSBsaXN0ZW5lcnMuXG4gKi9cbmZ1bmN0aW9uIHVub2JzZXJ2ZSAob2JqLCBwYXRoLCBvYnNlcnZlcikge1xuXG4gICAgaWYgKCFvYmogfHwgIW9iai5fX2VtaXR0ZXJfXykgcmV0dXJuXG5cbiAgICBwYXRoID0gcGF0aCA/IHBhdGggKyAnLicgOiAnJ1xuICAgIHZhciBwcm94aWVzID0gb2JzZXJ2ZXIucHJveGllc1twYXRoXVxuICAgIGlmICghcHJveGllcykgcmV0dXJuXG5cbiAgICAvLyB0dXJuIG9mZiBsaXN0ZW5lcnNcbiAgICBvYmouX19lbWl0dGVyX19cbiAgICAgICAgLm9mZignZ2V0JywgcHJveGllcy5nZXQpXG4gICAgICAgIC5vZmYoJ3NldCcsIHByb3hpZXMuc2V0KVxuICAgICAgICAub2ZmKCdtdXRhdGUnLCBwcm94aWVzLm11dGF0ZSlcblxuICAgIC8vIHJlbW92ZSByZWZlcmVuY2VcbiAgICBvYnNlcnZlci5wcm94aWVzW3BhdGhdID0gbnVsbFxufVxuXG4vLyBFeHBvc2UgQVBJIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbnZhciBwdWIgPSBtb2R1bGUuZXhwb3J0cyA9IHtcblxuICAgIC8vIHdoZXRoZXIgdG8gZW1pdCBnZXQgZXZlbnRzXG4gICAgLy8gb25seSBlbmFibGVkIGR1cmluZyBkZXBlbmRlbmN5IHBhcnNpbmdcbiAgICBzaG91bGRHZXQgICA6IGZhbHNlLFxuXG4gICAgb2JzZXJ2ZSAgICAgOiBvYnNlcnZlLFxuICAgIHVub2JzZXJ2ZSAgIDogdW5vYnNlcnZlLFxuICAgIGVuc3VyZVBhdGggIDogZW5zdXJlUGF0aCxcbiAgICBjb3B5UGF0aHMgICA6IGNvcHlQYXRocyxcbiAgICB3YXRjaCAgICAgICA6IHdhdGNoLFxuICAgIGNvbnZlcnQgICAgIDogY29udmVydCxcbiAgICBjb252ZXJ0S2V5ICA6IGNvbnZlcnRLZXlcbn0iLCJ2YXIgb3BlbkNoYXIgICAgICAgID0gJ3snLFxuICAgIGVuZENoYXIgICAgICAgICA9ICd9JyxcbiAgICBFU0NBUEVfUkUgICAgICAgPSAvWy0uKis/XiR7fSgpfFtcXF1cXC9cXFxcXS9nLFxuICAgIEJJTkRJTkdfUkUgICAgICA9IGJ1aWxkSW50ZXJwb2xhdGlvblJlZ2V4KCksXG4gICAgLy8gbGF6eSByZXF1aXJlXG4gICAgRGlyZWN0aXZlXG5cbmZ1bmN0aW9uIGJ1aWxkSW50ZXJwb2xhdGlvblJlZ2V4ICgpIHtcbiAgICB2YXIgb3BlbiA9IGVzY2FwZVJlZ2V4KG9wZW5DaGFyKSxcbiAgICAgICAgZW5kICA9IGVzY2FwZVJlZ2V4KGVuZENoYXIpXG4gICAgcmV0dXJuIG5ldyBSZWdFeHAob3BlbiArIG9wZW4gKyBvcGVuICsgJz8oLis/KScgKyBlbmQgKyAnPycgKyBlbmQgKyBlbmQpXG59XG5cbmZ1bmN0aW9uIGVzY2FwZVJlZ2V4IChzdHIpIHtcbiAgICByZXR1cm4gc3RyLnJlcGxhY2UoRVNDQVBFX1JFLCAnXFxcXCQmJylcbn1cblxuZnVuY3Rpb24gc2V0RGVsaW1pdGVycyAoZGVsaW1pdGVycykge1xuICAgIGV4cG9ydHMuZGVsaW1pdGVycyA9IGRlbGltaXRlcnNcbiAgICBvcGVuQ2hhciA9IGRlbGltaXRlcnNbMF1cbiAgICBlbmRDaGFyID0gZGVsaW1pdGVyc1sxXVxuICAgIEJJTkRJTkdfUkUgPSBidWlsZEludGVycG9sYXRpb25SZWdleCgpXG59XG5cbi8qKiBcbiAqICBQYXJzZSBhIHBpZWNlIG9mIHRleHQsIHJldHVybiBhbiBhcnJheSBvZiB0b2tlbnNcbiAqICB0b2tlbiB0eXBlczpcbiAqICAxLiBwbGFpbiBzdHJpbmdcbiAqICAyLiBvYmplY3Qgd2l0aCBrZXkgPSBiaW5kaW5nIGtleVxuICogIDMuIG9iamVjdCB3aXRoIGtleSAmIGh0bWwgPSB0cnVlXG4gKi9cbmZ1bmN0aW9uIHBhcnNlICh0ZXh0KSB7XG4gICAgaWYgKCFCSU5ESU5HX1JFLnRlc3QodGV4dCkpIHJldHVybiBudWxsXG4gICAgdmFyIG0sIGksIHRva2VuLCBtYXRjaCwgdG9rZW5zID0gW11cbiAgICAvKiBqc2hpbnQgYm9zczogdHJ1ZSAqL1xuICAgIHdoaWxlIChtID0gdGV4dC5tYXRjaChCSU5ESU5HX1JFKSkge1xuICAgICAgICBpID0gbS5pbmRleFxuICAgICAgICBpZiAoaSA+IDApIHRva2Vucy5wdXNoKHRleHQuc2xpY2UoMCwgaSkpXG4gICAgICAgIHRva2VuID0geyBrZXk6IG1bMV0udHJpbSgpIH1cbiAgICAgICAgbWF0Y2ggPSBtWzBdXG4gICAgICAgIHRva2VuLmh0bWwgPVxuICAgICAgICAgICAgbWF0Y2guY2hhckF0KDIpID09PSBvcGVuQ2hhciAmJlxuICAgICAgICAgICAgbWF0Y2guY2hhckF0KG1hdGNoLmxlbmd0aCAtIDMpID09PSBlbmRDaGFyXG4gICAgICAgIHRva2Vucy5wdXNoKHRva2VuKVxuICAgICAgICB0ZXh0ID0gdGV4dC5zbGljZShpICsgbVswXS5sZW5ndGgpXG4gICAgfVxuICAgIGlmICh0ZXh0Lmxlbmd0aCkgdG9rZW5zLnB1c2godGV4dClcbiAgICByZXR1cm4gdG9rZW5zXG59XG5cbi8qKlxuICogIFBhcnNlIGFuIGF0dHJpYnV0ZSB2YWx1ZSB3aXRoIHBvc3NpYmxlIGludGVycG9sYXRpb24gdGFnc1xuICogIHJldHVybiBhIERpcmVjdGl2ZS1mcmllbmRseSBleHByZXNzaW9uXG4gKlxuICogIGUuZy4gIGEge3tifX0gYyAgPT4gIFwiYSBcIiArIGIgKyBcIiBjXCJcbiAqL1xuZnVuY3Rpb24gcGFyc2VBdHRyIChhdHRyKSB7XG4gICAgRGlyZWN0aXZlID0gRGlyZWN0aXZlIHx8IHJlcXVpcmUoJy4vZGlyZWN0aXZlJylcbiAgICB2YXIgdG9rZW5zID0gcGFyc2UoYXR0cilcbiAgICBpZiAoIXRva2VucykgcmV0dXJuIG51bGxcbiAgICBpZiAodG9rZW5zLmxlbmd0aCA9PT0gMSkgcmV0dXJuIHRva2Vuc1swXS5rZXlcbiAgICB2YXIgcmVzID0gW10sIHRva2VuXG4gICAgZm9yICh2YXIgaSA9IDAsIGwgPSB0b2tlbnMubGVuZ3RoOyBpIDwgbDsgaSsrKSB7XG4gICAgICAgIHRva2VuID0gdG9rZW5zW2ldXG4gICAgICAgIHJlcy5wdXNoKFxuICAgICAgICAgICAgdG9rZW4ua2V5XG4gICAgICAgICAgICAgICAgPyBpbmxpbmVGaWx0ZXJzKHRva2VuLmtleSlcbiAgICAgICAgICAgICAgICA6ICgnXCInICsgdG9rZW4gKyAnXCInKVxuICAgICAgICApXG4gICAgfVxuICAgIHJldHVybiByZXMuam9pbignKycpXG59XG5cbi8qKlxuICogIElubGluZXMgYW55IHBvc3NpYmxlIGZpbHRlcnMgaW4gYSBiaW5kaW5nXG4gKiAgc28gdGhhdCB3ZSBjYW4gY29tYmluZSBldmVyeXRoaW5nIGludG8gYSBodWdlIGV4cHJlc3Npb25cbiAqL1xuZnVuY3Rpb24gaW5saW5lRmlsdGVycyAoa2V5KSB7XG4gICAgaWYgKGtleS5pbmRleE9mKCd8JykgPiAtMSkge1xuICAgICAgICB2YXIgZGlycyA9IERpcmVjdGl2ZS5wYXJzZShrZXkpLFxuICAgICAgICAgICAgZGlyID0gZGlycyAmJiBkaXJzWzBdXG4gICAgICAgIGlmIChkaXIgJiYgZGlyLmZpbHRlcnMpIHtcbiAgICAgICAgICAgIGtleSA9IERpcmVjdGl2ZS5pbmxpbmVGaWx0ZXJzKFxuICAgICAgICAgICAgICAgIGRpci5rZXksXG4gICAgICAgICAgICAgICAgZGlyLmZpbHRlcnNcbiAgICAgICAgICAgIClcbiAgICAgICAgfVxuICAgIH1cbiAgICByZXR1cm4gJygnICsga2V5ICsgJyknXG59XG5cbmV4cG9ydHMucGFyc2UgICAgICAgICA9IHBhcnNlXG5leHBvcnRzLnBhcnNlQXR0ciAgICAgPSBwYXJzZUF0dHJcbmV4cG9ydHMuc2V0RGVsaW1pdGVycyA9IHNldERlbGltaXRlcnNcbmV4cG9ydHMuZGVsaW1pdGVycyAgICA9IFtvcGVuQ2hhciwgZW5kQ2hhcl0iLCJ2YXIgZW5kRXZlbnRzICA9IHNuaWZmRW5kRXZlbnRzKCksXG4gICAgY29uZmlnICAgICA9IHJlcXVpcmUoJy4vY29uZmlnJyksXG4gICAgLy8gYmF0Y2ggZW50ZXIgYW5pbWF0aW9ucyBzbyB3ZSBvbmx5IGZvcmNlIHRoZSBsYXlvdXQgb25jZVxuICAgIEJhdGNoZXIgICAgPSByZXF1aXJlKCcuL2JhdGNoZXInKSxcbiAgICBiYXRjaGVyICAgID0gbmV3IEJhdGNoZXIoKSxcbiAgICAvLyBjYWNoZSB0aW1lciBmdW5jdGlvbnNcbiAgICBzZXRUTyAgICAgID0gd2luZG93LnNldFRpbWVvdXQsXG4gICAgY2xlYXJUTyAgICA9IHdpbmRvdy5jbGVhclRpbWVvdXQsXG4gICAgLy8gZXhpdCBjb2RlcyBmb3IgdGVzdGluZ1xuICAgIGNvZGVzID0ge1xuICAgICAgICBDU1NfRSAgICAgOiAxLFxuICAgICAgICBDU1NfTCAgICAgOiAyLFxuICAgICAgICBKU19FICAgICAgOiAzLFxuICAgICAgICBKU19MICAgICAgOiA0LFxuICAgICAgICBDU1NfU0tJUCAgOiAtMSxcbiAgICAgICAgSlNfU0tJUCAgIDogLTIsXG4gICAgICAgIEpTX1NLSVBfRSA6IC0zLFxuICAgICAgICBKU19TS0lQX0wgOiAtNCxcbiAgICAgICAgSU5JVCAgICAgIDogLTUsXG4gICAgICAgIFNLSVAgICAgICA6IC02XG4gICAgfVxuXG4vLyBmb3JjZSBsYXlvdXQgYmVmb3JlIHRyaWdnZXJpbmcgdHJhbnNpdGlvbnMvYW5pbWF0aW9uc1xuYmF0Y2hlci5fcHJlRmx1c2ggPSBmdW5jdGlvbiAoKSB7XG4gICAgLyoganNoaW50IHVudXNlZDogZmFsc2UgKi9cbiAgICB2YXIgZiA9IGRvY3VtZW50LmJvZHkub2Zmc2V0SGVpZ2h0XG59XG5cbi8qKlxuICogIHN0YWdlOlxuICogICAgMSA9IGVudGVyXG4gKiAgICAyID0gbGVhdmVcbiAqL1xudmFyIHRyYW5zaXRpb24gPSBtb2R1bGUuZXhwb3J0cyA9IGZ1bmN0aW9uIChlbCwgc3RhZ2UsIGNiLCBjb21waWxlcikge1xuXG4gICAgdmFyIGNoYW5nZVN0YXRlID0gZnVuY3Rpb24gKCkge1xuICAgICAgICBjYigpXG4gICAgICAgIGNvbXBpbGVyLmV4ZWNIb29rKHN0YWdlID4gMCA/ICdhdHRhY2hlZCcgOiAnZGV0YWNoZWQnKVxuICAgIH1cblxuICAgIGlmIChjb21waWxlci5pbml0KSB7XG4gICAgICAgIGNoYW5nZVN0YXRlKClcbiAgICAgICAgcmV0dXJuIGNvZGVzLklOSVRcbiAgICB9XG5cbiAgICB2YXIgaGFzVHJhbnNpdGlvbiA9IGVsLnZ1ZV90cmFucyA9PT0gJycsXG4gICAgICAgIGhhc0FuaW1hdGlvbiAgPSBlbC52dWVfYW5pbSA9PT0gJycsXG4gICAgICAgIGVmZmVjdElkICAgICAgPSBlbC52dWVfZWZmZWN0XG5cbiAgICBpZiAoZWZmZWN0SWQpIHtcbiAgICAgICAgcmV0dXJuIGFwcGx5VHJhbnNpdGlvbkZ1bmN0aW9ucyhcbiAgICAgICAgICAgIGVsLFxuICAgICAgICAgICAgc3RhZ2UsXG4gICAgICAgICAgICBjaGFuZ2VTdGF0ZSxcbiAgICAgICAgICAgIGVmZmVjdElkLFxuICAgICAgICAgICAgY29tcGlsZXJcbiAgICAgICAgKVxuICAgIH0gZWxzZSBpZiAoaGFzVHJhbnNpdGlvbiB8fCBoYXNBbmltYXRpb24pIHtcbiAgICAgICAgcmV0dXJuIGFwcGx5VHJhbnNpdGlvbkNsYXNzKFxuICAgICAgICAgICAgZWwsXG4gICAgICAgICAgICBzdGFnZSxcbiAgICAgICAgICAgIGNoYW5nZVN0YXRlLFxuICAgICAgICAgICAgaGFzQW5pbWF0aW9uXG4gICAgICAgIClcbiAgICB9IGVsc2Uge1xuICAgICAgICBjaGFuZ2VTdGF0ZSgpXG4gICAgICAgIHJldHVybiBjb2Rlcy5TS0lQXG4gICAgfVxuXG59XG5cbnRyYW5zaXRpb24uY29kZXMgPSBjb2Rlc1xuXG4vKipcbiAqICBUb2dnZ2xlIGEgQ1NTIGNsYXNzIHRvIHRyaWdnZXIgdHJhbnNpdGlvblxuICovXG5mdW5jdGlvbiBhcHBseVRyYW5zaXRpb25DbGFzcyAoZWwsIHN0YWdlLCBjaGFuZ2VTdGF0ZSwgaGFzQW5pbWF0aW9uKSB7XG5cbiAgICBpZiAoIWVuZEV2ZW50cy50cmFucykge1xuICAgICAgICBjaGFuZ2VTdGF0ZSgpXG4gICAgICAgIHJldHVybiBjb2Rlcy5DU1NfU0tJUFxuICAgIH1cblxuICAgIC8vIGlmIHRoZSBicm93c2VyIHN1cHBvcnRzIHRyYW5zaXRpb24sXG4gICAgLy8gaXQgbXVzdCBoYXZlIGNsYXNzTGlzdC4uLlxuICAgIHZhciBvbkVuZCxcbiAgICAgICAgY2xhc3NMaXN0ICAgICAgICA9IGVsLmNsYXNzTGlzdCxcbiAgICAgICAgZXhpc3RpbmdDYWxsYmFjayA9IGVsLnZ1ZV90cmFuc19jYixcbiAgICAgICAgZW50ZXJDbGFzcyAgICAgICA9IGNvbmZpZy5lbnRlckNsYXNzLFxuICAgICAgICBsZWF2ZUNsYXNzICAgICAgID0gY29uZmlnLmxlYXZlQ2xhc3MsXG4gICAgICAgIGVuZEV2ZW50ICAgICAgICAgPSBoYXNBbmltYXRpb24gPyBlbmRFdmVudHMuYW5pbSA6IGVuZEV2ZW50cy50cmFuc1xuXG4gICAgLy8gY2FuY2VsIHVuZmluaXNoZWQgY2FsbGJhY2tzIGFuZCBqb2JzXG4gICAgaWYgKGV4aXN0aW5nQ2FsbGJhY2spIHtcbiAgICAgICAgZWwucmVtb3ZlRXZlbnRMaXN0ZW5lcihlbmRFdmVudCwgZXhpc3RpbmdDYWxsYmFjaylcbiAgICAgICAgY2xhc3NMaXN0LnJlbW92ZShlbnRlckNsYXNzKVxuICAgICAgICBjbGFzc0xpc3QucmVtb3ZlKGxlYXZlQ2xhc3MpXG4gICAgICAgIGVsLnZ1ZV90cmFuc19jYiA9IG51bGxcbiAgICB9XG5cbiAgICBpZiAoc3RhZ2UgPiAwKSB7IC8vIGVudGVyXG5cbiAgICAgICAgLy8gc2V0IHRvIGVudGVyIHN0YXRlIGJlZm9yZSBhcHBlbmRpbmdcbiAgICAgICAgY2xhc3NMaXN0LmFkZChlbnRlckNsYXNzKVxuICAgICAgICAvLyBhcHBlbmRcbiAgICAgICAgY2hhbmdlU3RhdGUoKVxuICAgICAgICAvLyB0cmlnZ2VyIHRyYW5zaXRpb25cbiAgICAgICAgaWYgKCFoYXNBbmltYXRpb24pIHtcbiAgICAgICAgICAgIGJhdGNoZXIucHVzaCh7XG4gICAgICAgICAgICAgICAgZXhlY3V0ZTogZnVuY3Rpb24gKCkge1xuICAgICAgICAgICAgICAgICAgICBjbGFzc0xpc3QucmVtb3ZlKGVudGVyQ2xhc3MpXG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSlcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIG9uRW5kID0gZnVuY3Rpb24gKGUpIHtcbiAgICAgICAgICAgICAgICBpZiAoZS50YXJnZXQgPT09IGVsKSB7XG4gICAgICAgICAgICAgICAgICAgIGVsLnJlbW92ZUV2ZW50TGlzdGVuZXIoZW5kRXZlbnQsIG9uRW5kKVxuICAgICAgICAgICAgICAgICAgICBlbC52dWVfdHJhbnNfY2IgPSBudWxsXG4gICAgICAgICAgICAgICAgICAgIGNsYXNzTGlzdC5yZW1vdmUoZW50ZXJDbGFzcylcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBlbC5hZGRFdmVudExpc3RlbmVyKGVuZEV2ZW50LCBvbkVuZClcbiAgICAgICAgICAgIGVsLnZ1ZV90cmFuc19jYiA9IG9uRW5kXG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIGNvZGVzLkNTU19FXG5cbiAgICB9IGVsc2UgeyAvLyBsZWF2ZVxuXG4gICAgICAgIGlmIChlbC5vZmZzZXRXaWR0aCB8fCBlbC5vZmZzZXRIZWlnaHQpIHtcbiAgICAgICAgICAgIC8vIHRyaWdnZXIgaGlkZSB0cmFuc2l0aW9uXG4gICAgICAgICAgICBjbGFzc0xpc3QuYWRkKGxlYXZlQ2xhc3MpXG4gICAgICAgICAgICBvbkVuZCA9IGZ1bmN0aW9uIChlKSB7XG4gICAgICAgICAgICAgICAgaWYgKGUudGFyZ2V0ID09PSBlbCkge1xuICAgICAgICAgICAgICAgICAgICBlbC5yZW1vdmVFdmVudExpc3RlbmVyKGVuZEV2ZW50LCBvbkVuZClcbiAgICAgICAgICAgICAgICAgICAgZWwudnVlX3RyYW5zX2NiID0gbnVsbFxuICAgICAgICAgICAgICAgICAgICAvLyBhY3R1YWxseSByZW1vdmUgbm9kZSBoZXJlXG4gICAgICAgICAgICAgICAgICAgIGNoYW5nZVN0YXRlKClcbiAgICAgICAgICAgICAgICAgICAgY2xhc3NMaXN0LnJlbW92ZShsZWF2ZUNsYXNzKVxuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIC8vIGF0dGFjaCB0cmFuc2l0aW9uIGVuZCBsaXN0ZW5lclxuICAgICAgICAgICAgZWwuYWRkRXZlbnRMaXN0ZW5lcihlbmRFdmVudCwgb25FbmQpXG4gICAgICAgICAgICBlbC52dWVfdHJhbnNfY2IgPSBvbkVuZFxuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgLy8gZGlyZWN0bHkgcmVtb3ZlIGludmlzaWJsZSBlbGVtZW50c1xuICAgICAgICAgICAgY2hhbmdlU3RhdGUoKVxuICAgICAgICB9XG4gICAgICAgIHJldHVybiBjb2Rlcy5DU1NfTFxuICAgICAgICBcbiAgICB9XG5cbn1cblxuZnVuY3Rpb24gYXBwbHlUcmFuc2l0aW9uRnVuY3Rpb25zIChlbCwgc3RhZ2UsIGNoYW5nZVN0YXRlLCBlZmZlY3RJZCwgY29tcGlsZXIpIHtcblxuICAgIHZhciBmdW5jcyA9IGNvbXBpbGVyLmdldE9wdGlvbignZWZmZWN0cycsIGVmZmVjdElkKVxuICAgIGlmICghZnVuY3MpIHtcbiAgICAgICAgY2hhbmdlU3RhdGUoKVxuICAgICAgICByZXR1cm4gY29kZXMuSlNfU0tJUFxuICAgIH1cblxuICAgIHZhciBlbnRlciA9IGZ1bmNzLmVudGVyLFxuICAgICAgICBsZWF2ZSA9IGZ1bmNzLmxlYXZlLFxuICAgICAgICB0aW1lb3V0cyA9IGVsLnZ1ZV90aW1lb3V0c1xuXG4gICAgLy8gY2xlYXIgcHJldmlvdXMgdGltZW91dHNcbiAgICBpZiAodGltZW91dHMpIHtcbiAgICAgICAgdmFyIGkgPSB0aW1lb3V0cy5sZW5ndGhcbiAgICAgICAgd2hpbGUgKGktLSkge1xuICAgICAgICAgICAgY2xlYXJUTyh0aW1lb3V0c1tpXSlcbiAgICAgICAgfVxuICAgIH1cblxuICAgIHRpbWVvdXRzID0gZWwudnVlX3RpbWVvdXRzID0gW11cbiAgICBmdW5jdGlvbiB0aW1lb3V0IChjYiwgZGVsYXkpIHtcbiAgICAgICAgdmFyIGlkID0gc2V0VE8oZnVuY3Rpb24gKCkge1xuICAgICAgICAgICAgY2IoKVxuICAgICAgICAgICAgdGltZW91dHMuc3BsaWNlKHRpbWVvdXRzLmluZGV4T2YoaWQpLCAxKVxuICAgICAgICAgICAgaWYgKCF0aW1lb3V0cy5sZW5ndGgpIHtcbiAgICAgICAgICAgICAgICBlbC52dWVfdGltZW91dHMgPSBudWxsXG4gICAgICAgICAgICB9XG4gICAgICAgIH0sIGRlbGF5KVxuICAgICAgICB0aW1lb3V0cy5wdXNoKGlkKVxuICAgIH1cblxuICAgIGlmIChzdGFnZSA+IDApIHsgLy8gZW50ZXJcbiAgICAgICAgaWYgKHR5cGVvZiBlbnRlciAhPT0gJ2Z1bmN0aW9uJykge1xuICAgICAgICAgICAgY2hhbmdlU3RhdGUoKVxuICAgICAgICAgICAgcmV0dXJuIGNvZGVzLkpTX1NLSVBfRVxuICAgICAgICB9XG4gICAgICAgIGVudGVyKGVsLCBjaGFuZ2VTdGF0ZSwgdGltZW91dClcbiAgICAgICAgcmV0dXJuIGNvZGVzLkpTX0VcbiAgICB9IGVsc2UgeyAvLyBsZWF2ZVxuICAgICAgICBpZiAodHlwZW9mIGxlYXZlICE9PSAnZnVuY3Rpb24nKSB7XG4gICAgICAgICAgICBjaGFuZ2VTdGF0ZSgpXG4gICAgICAgICAgICByZXR1cm4gY29kZXMuSlNfU0tJUF9MXG4gICAgICAgIH1cbiAgICAgICAgbGVhdmUoZWwsIGNoYW5nZVN0YXRlLCB0aW1lb3V0KVxuICAgICAgICByZXR1cm4gY29kZXMuSlNfTFxuICAgIH1cblxufVxuXG4vKipcbiAqICBTbmlmZiBwcm9wZXIgdHJhbnNpdGlvbiBlbmQgZXZlbnQgbmFtZVxuICovXG5mdW5jdGlvbiBzbmlmZkVuZEV2ZW50cyAoKSB7XG4gICAgdmFyIGVsID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgndnVlJyksXG4gICAgICAgIGRlZmF1bHRFdmVudCA9ICd0cmFuc2l0aW9uZW5kJyxcbiAgICAgICAgZXZlbnRzID0ge1xuICAgICAgICAgICAgJ3RyYW5zaXRpb24nICAgICAgIDogZGVmYXVsdEV2ZW50LFxuICAgICAgICAgICAgJ21velRyYW5zaXRpb24nICAgIDogZGVmYXVsdEV2ZW50LFxuICAgICAgICAgICAgJ3dlYmtpdFRyYW5zaXRpb24nIDogJ3dlYmtpdFRyYW5zaXRpb25FbmQnXG4gICAgICAgIH0sXG4gICAgICAgIHJldCA9IHt9XG4gICAgZm9yICh2YXIgbmFtZSBpbiBldmVudHMpIHtcbiAgICAgICAgaWYgKGVsLnN0eWxlW25hbWVdICE9PSB1bmRlZmluZWQpIHtcbiAgICAgICAgICAgIHJldC50cmFucyA9IGV2ZW50c1tuYW1lXVxuICAgICAgICAgICAgYnJlYWtcbiAgICAgICAgfVxuICAgIH1cbiAgICByZXQuYW5pbSA9IGVsLnN0eWxlLmFuaW1hdGlvbiA9PT0gJydcbiAgICAgICAgPyAnYW5pbWF0aW9uZW5kJ1xuICAgICAgICA6ICd3ZWJraXRBbmltYXRpb25FbmQnXG4gICAgcmV0dXJuIHJldFxufSIsInZhciBjb25maWcgICAgPSByZXF1aXJlKCcuL2NvbmZpZycpLFxuICAgIHRvU3RyaW5nICA9ICh7fSkudG9TdHJpbmcsXG4gICAgd2luICAgICAgID0gd2luZG93LFxuICAgIGNvbnNvbGUgICA9IHdpbi5jb25zb2xlLFxuICAgIHRpbWVvdXQgICA9IHdpbi5zZXRUaW1lb3V0LFxuICAgIGRlZiAgICAgICA9IE9iamVjdC5kZWZpbmVQcm9wZXJ0eSxcbiAgICBUSElTX1JFICAgPSAvW15cXHdddGhpc1teXFx3XS8sXG4gICAgT0JKRUNUICAgID0gJ29iamVjdCcsXG4gICAgaGFzQ2xhc3NMaXN0ID0gJ2NsYXNzTGlzdCcgaW4gZG9jdW1lbnQuZG9jdW1lbnRFbGVtZW50LFxuICAgIFZpZXdNb2RlbCAvLyBsYXRlIGRlZlxuXG52YXIgdXRpbHMgPSBtb2R1bGUuZXhwb3J0cyA9IHtcblxuICAgIC8qKlxuICAgICAqICBnZXQgYSB2YWx1ZSBmcm9tIGFuIG9iamVjdCBrZXlwYXRoXG4gICAgICovXG4gICAgZ2V0OiBmdW5jdGlvbiAob2JqLCBrZXkpIHtcbiAgICAgICAgLyoganNoaW50IGVxZXFlcTogZmFsc2UgKi9cbiAgICAgICAgaWYgKGtleS5pbmRleE9mKCcuJykgPCAwKSB7XG4gICAgICAgICAgICByZXR1cm4gb2JqW2tleV1cbiAgICAgICAgfVxuICAgICAgICB2YXIgcGF0aCA9IGtleS5zcGxpdCgnLicpLFxuICAgICAgICAgICAgZCA9IC0xLCBsID0gcGF0aC5sZW5ndGhcbiAgICAgICAgd2hpbGUgKCsrZCA8IGwgJiYgb2JqICE9IG51bGwpIHtcbiAgICAgICAgICAgIG9iaiA9IG9ialtwYXRoW2RdXVxuICAgICAgICB9XG4gICAgICAgIHJldHVybiBvYmpcbiAgICB9LFxuXG4gICAgLyoqXG4gICAgICogIHNldCBhIHZhbHVlIHRvIGFuIG9iamVjdCBrZXlwYXRoXG4gICAgICovXG4gICAgc2V0OiBmdW5jdGlvbiAob2JqLCBrZXksIHZhbCkge1xuICAgICAgICAvKiBqc2hpbnQgZXFlcWVxOiBmYWxzZSAqL1xuICAgICAgICBpZiAoa2V5LmluZGV4T2YoJy4nKSA8IDApIHtcbiAgICAgICAgICAgIG9ialtrZXldID0gdmFsXG4gICAgICAgICAgICByZXR1cm5cbiAgICAgICAgfVxuICAgICAgICB2YXIgcGF0aCA9IGtleS5zcGxpdCgnLicpLFxuICAgICAgICAgICAgZCA9IC0xLCBsID0gcGF0aC5sZW5ndGggLSAxXG4gICAgICAgIHdoaWxlICgrK2QgPCBsKSB7XG4gICAgICAgICAgICBpZiAob2JqW3BhdGhbZF1dID09IG51bGwpIHtcbiAgICAgICAgICAgICAgICBvYmpbcGF0aFtkXV0gPSB7fVxuICAgICAgICAgICAgfVxuICAgICAgICAgICAgb2JqID0gb2JqW3BhdGhbZF1dXG4gICAgICAgIH1cbiAgICAgICAgb2JqW3BhdGhbZF1dID0gdmFsXG4gICAgfSxcblxuICAgIC8qKlxuICAgICAqICByZXR1cm4gdGhlIGJhc2Ugc2VnbWVudCBvZiBhIGtleXBhdGhcbiAgICAgKi9cbiAgICBiYXNlS2V5OiBmdW5jdGlvbiAoa2V5KSB7XG4gICAgICAgIHJldHVybiBrZXkuaW5kZXhPZignLicpID4gMFxuICAgICAgICAgICAgPyBrZXkuc3BsaXQoJy4nKVswXVxuICAgICAgICAgICAgOiBrZXlcbiAgICB9LFxuXG4gICAgLyoqXG4gICAgICogIENyZWF0ZSBhIHByb3RvdHlwZS1sZXNzIG9iamVjdFxuICAgICAqICB3aGljaCBpcyBhIGJldHRlciBoYXNoL21hcFxuICAgICAqL1xuICAgIGhhc2g6IGZ1bmN0aW9uICgpIHtcbiAgICAgICAgcmV0dXJuIE9iamVjdC5jcmVhdGUobnVsbClcbiAgICB9LFxuXG4gICAgLyoqXG4gICAgICogIGdldCBhbiBhdHRyaWJ1dGUgYW5kIHJlbW92ZSBpdC5cbiAgICAgKi9cbiAgICBhdHRyOiBmdW5jdGlvbiAoZWwsIHR5cGUpIHtcbiAgICAgICAgdmFyIGF0dHIgPSBjb25maWcucHJlZml4ICsgJy0nICsgdHlwZSxcbiAgICAgICAgICAgIHZhbCA9IGVsLmdldEF0dHJpYnV0ZShhdHRyKVxuICAgICAgICBpZiAodmFsICE9PSBudWxsKSB7XG4gICAgICAgICAgICBlbC5yZW1vdmVBdHRyaWJ1dGUoYXR0cilcbiAgICAgICAgfVxuICAgICAgICByZXR1cm4gdmFsXG4gICAgfSxcblxuICAgIC8qKlxuICAgICAqICBEZWZpbmUgYW4gaWVudW1lcmFibGUgcHJvcGVydHlcbiAgICAgKiAgVGhpcyBhdm9pZHMgaXQgYmVpbmcgaW5jbHVkZWQgaW4gSlNPTi5zdHJpbmdpZnlcbiAgICAgKiAgb3IgZm9yLi4uaW4gbG9vcHMuXG4gICAgICovXG4gICAgZGVmUHJvdGVjdGVkOiBmdW5jdGlvbiAob2JqLCBrZXksIHZhbCwgZW51bWVyYWJsZSwgd3JpdGFibGUpIHtcbiAgICAgICAgZGVmKG9iaiwga2V5LCB7XG4gICAgICAgICAgICB2YWx1ZSAgICAgICAgOiB2YWwsXG4gICAgICAgICAgICBlbnVtZXJhYmxlICAgOiBlbnVtZXJhYmxlLFxuICAgICAgICAgICAgd3JpdGFibGUgICAgIDogd3JpdGFibGUsXG4gICAgICAgICAgICBjb25maWd1cmFibGUgOiB0cnVlXG4gICAgICAgIH0pXG4gICAgfSxcblxuICAgIC8qKlxuICAgICAqICBBIGxlc3MgYnVsbGV0LXByb29mIGJ1dCBtb3JlIGVmZmljaWVudCB0eXBlIGNoZWNrXG4gICAgICogIHRoYW4gT2JqZWN0LnByb3RvdHlwZS50b1N0cmluZ1xuICAgICAqL1xuICAgIGlzT2JqZWN0OiBmdW5jdGlvbiAob2JqKSB7XG4gICAgICAgIHJldHVybiB0eXBlb2Ygb2JqID09PSBPQkpFQ1QgJiYgb2JqICYmICFBcnJheS5pc0FycmF5KG9iailcbiAgICB9LFxuXG4gICAgLyoqXG4gICAgICogIEEgbW9yZSBhY2N1cmF0ZSBidXQgbGVzcyBlZmZpY2llbnQgdHlwZSBjaGVja1xuICAgICAqL1xuICAgIGlzVHJ1ZU9iamVjdDogZnVuY3Rpb24gKG9iaikge1xuICAgICAgICByZXR1cm4gdG9TdHJpbmcuY2FsbChvYmopID09PSAnW29iamVjdCBPYmplY3RdJ1xuICAgIH0sXG5cbiAgICAvKipcbiAgICAgKiAgTW9zdCBzaW1wbGUgYmluZFxuICAgICAqICBlbm91Z2ggZm9yIHRoZSB1c2VjYXNlIGFuZCBmYXN0IHRoYW4gbmF0aXZlIGJpbmQoKVxuICAgICAqL1xuICAgIGJpbmQ6IGZ1bmN0aW9uIChmbiwgY3R4KSB7XG4gICAgICAgIHJldHVybiBmdW5jdGlvbiAoYXJnKSB7XG4gICAgICAgICAgICByZXR1cm4gZm4uY2FsbChjdHgsIGFyZylcbiAgICAgICAgfVxuICAgIH0sXG5cbiAgICAvKipcbiAgICAgKiAgTWFrZSBzdXJlIG51bGwgYW5kIHVuZGVmaW5lZCBvdXRwdXQgZW1wdHkgc3RyaW5nXG4gICAgICovXG4gICAgZ3VhcmQ6IGZ1bmN0aW9uICh2YWx1ZSkge1xuICAgICAgICAvKiBqc2hpbnQgZXFlcWVxOiBmYWxzZSwgZXFudWxsOiB0cnVlICovXG4gICAgICAgIHJldHVybiB2YWx1ZSA9PSBudWxsXG4gICAgICAgICAgICA/ICcnXG4gICAgICAgICAgICA6ICh0eXBlb2YgdmFsdWUgPT0gJ29iamVjdCcpXG4gICAgICAgICAgICAgICAgPyBKU09OLnN0cmluZ2lmeSh2YWx1ZSlcbiAgICAgICAgICAgICAgICA6IHZhbHVlXG4gICAgfSxcblxuICAgIC8qKlxuICAgICAqICBXaGVuIHNldHRpbmcgdmFsdWUgb24gdGhlIFZNLCBwYXJzZSBwb3NzaWJsZSBudW1iZXJzXG4gICAgICovXG4gICAgY2hlY2tOdW1iZXI6IGZ1bmN0aW9uICh2YWx1ZSkge1xuICAgICAgICByZXR1cm4gKGlzTmFOKHZhbHVlKSB8fCB2YWx1ZSA9PT0gbnVsbCB8fCB0eXBlb2YgdmFsdWUgPT09ICdib29sZWFuJylcbiAgICAgICAgICAgID8gdmFsdWVcbiAgICAgICAgICAgIDogTnVtYmVyKHZhbHVlKVxuICAgIH0sXG5cbiAgICAvKipcbiAgICAgKiAgc2ltcGxlIGV4dGVuZFxuICAgICAqL1xuICAgIGV4dGVuZDogZnVuY3Rpb24gKG9iaiwgZXh0KSB7XG4gICAgICAgIGZvciAodmFyIGtleSBpbiBleHQpIHtcbiAgICAgICAgICAgIGlmIChvYmpba2V5XSAhPT0gZXh0W2tleV0pIHtcbiAgICAgICAgICAgICAgICBvYmpba2V5XSA9IGV4dFtrZXldXG4gICAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIG9ialxuICAgIH0sXG5cbiAgICAvKipcbiAgICAgKiAgZmlsdGVyIGFuIGFycmF5IHdpdGggZHVwbGljYXRlcyBpbnRvIHVuaXF1ZXNcbiAgICAgKi9cbiAgICB1bmlxdWU6IGZ1bmN0aW9uIChhcnIpIHtcbiAgICAgICAgdmFyIGhhc2ggPSB1dGlscy5oYXNoKCksXG4gICAgICAgICAgICBpID0gYXJyLmxlbmd0aCxcbiAgICAgICAgICAgIGtleSwgcmVzID0gW11cbiAgICAgICAgd2hpbGUgKGktLSkge1xuICAgICAgICAgICAga2V5ID0gYXJyW2ldXG4gICAgICAgICAgICBpZiAoaGFzaFtrZXldKSBjb250aW51ZVxuICAgICAgICAgICAgaGFzaFtrZXldID0gMVxuICAgICAgICAgICAgcmVzLnB1c2goa2V5KVxuICAgICAgICB9XG4gICAgICAgIHJldHVybiByZXNcbiAgICB9LFxuXG4gICAgLyoqXG4gICAgICogIENvbnZlcnQgYSBzdHJpbmcgdGVtcGxhdGUgdG8gYSBkb20gZnJhZ21lbnRcbiAgICAgKi9cbiAgICB0b0ZyYWdtZW50OiBmdW5jdGlvbiAodGVtcGxhdGUpIHtcbiAgICAgICAgaWYgKHR5cGVvZiB0ZW1wbGF0ZSAhPT0gJ3N0cmluZycpIHtcbiAgICAgICAgICAgIHJldHVybiB0ZW1wbGF0ZVxuICAgICAgICB9XG4gICAgICAgIGlmICh0ZW1wbGF0ZS5jaGFyQXQoMCkgPT09ICcjJykge1xuICAgICAgICAgICAgdmFyIHRlbXBsYXRlTm9kZSA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKHRlbXBsYXRlLnNsaWNlKDEpKVxuICAgICAgICAgICAgaWYgKCF0ZW1wbGF0ZU5vZGUpIHJldHVyblxuICAgICAgICAgICAgLy8gaWYgaXRzIGEgdGVtcGxhdGUgdGFnIGFuZCB0aGUgYnJvd3NlciBzdXBwb3J0cyBpdCxcbiAgICAgICAgICAgIC8vIGl0cyBjb250ZW50IGlzIGFscmVhZHkgYSBkb2N1bWVudCBmcmFnbWVudCFcbiAgICAgICAgICAgIGlmICh0ZW1wbGF0ZU5vZGUudGFnTmFtZSA9PT0gJ1RFTVBMQVRFJyAmJiB0ZW1wbGF0ZU5vZGUuY29udGVudCkge1xuICAgICAgICAgICAgICAgIHJldHVybiB0ZW1wbGF0ZU5vZGUuY29udGVudFxuICAgICAgICAgICAgfVxuICAgICAgICAgICAgdGVtcGxhdGUgPSB0ZW1wbGF0ZU5vZGUuaW5uZXJIVE1MXG4gICAgICAgIH1cbiAgICAgICAgdmFyIG5vZGUgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdkaXYnKSxcbiAgICAgICAgICAgIGZyYWcgPSBkb2N1bWVudC5jcmVhdGVEb2N1bWVudEZyYWdtZW50KCksXG4gICAgICAgICAgICBjaGlsZFxuICAgICAgICBub2RlLmlubmVySFRNTCA9IHRlbXBsYXRlLnRyaW0oKVxuICAgICAgICAvKiBqc2hpbnQgYm9zczogdHJ1ZSAqL1xuICAgICAgICB3aGlsZSAoY2hpbGQgPSBub2RlLmZpcnN0Q2hpbGQpIHtcbiAgICAgICAgICAgIGlmIChub2RlLm5vZGVUeXBlID09PSAxKSB7XG4gICAgICAgICAgICAgICAgZnJhZy5hcHBlbmRDaGlsZChjaGlsZClcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgICByZXR1cm4gZnJhZ1xuICAgIH0sXG5cbiAgICAvKipcbiAgICAgKiAgQ29udmVydCB0aGUgb2JqZWN0IHRvIGEgVmlld01vZGVsIGNvbnN0cnVjdG9yXG4gICAgICogIGlmIGl0IGlzIG5vdCBhbHJlYWR5IG9uZVxuICAgICAqL1xuICAgIHRvQ29uc3RydWN0b3I6IGZ1bmN0aW9uIChvYmopIHtcbiAgICAgICAgVmlld01vZGVsID0gVmlld01vZGVsIHx8IHJlcXVpcmUoJy4vdmlld21vZGVsJylcbiAgICAgICAgcmV0dXJuIHV0aWxzLmlzT2JqZWN0KG9iailcbiAgICAgICAgICAgID8gVmlld01vZGVsLmV4dGVuZChvYmopXG4gICAgICAgICAgICA6IHR5cGVvZiBvYmogPT09ICdmdW5jdGlvbidcbiAgICAgICAgICAgICAgICA/IG9ialxuICAgICAgICAgICAgICAgIDogbnVsbFxuICAgIH0sXG5cbiAgICAvKipcbiAgICAgKiAgQ2hlY2sgaWYgYSBmaWx0ZXIgZnVuY3Rpb24gY29udGFpbnMgcmVmZXJlbmNlcyB0byBgdGhpc2BcbiAgICAgKiAgSWYgeWVzLCBtYXJrIGl0IGFzIGEgY29tcHV0ZWQgZmlsdGVyLlxuICAgICAqL1xuICAgIGNoZWNrRmlsdGVyOiBmdW5jdGlvbiAoZmlsdGVyKSB7XG4gICAgICAgIGlmIChUSElTX1JFLnRlc3QoZmlsdGVyLnRvU3RyaW5nKCkpKSB7XG4gICAgICAgICAgICBmaWx0ZXIuY29tcHV0ZWQgPSB0cnVlXG4gICAgICAgIH1cbiAgICB9LFxuXG4gICAgLyoqXG4gICAgICogIGNvbnZlcnQgY2VydGFpbiBvcHRpb24gdmFsdWVzIHRvIHRoZSBkZXNpcmVkIGZvcm1hdC5cbiAgICAgKi9cbiAgICBwcm9jZXNzT3B0aW9uczogZnVuY3Rpb24gKG9wdGlvbnMpIHtcbiAgICAgICAgdmFyIGNvbXBvbmVudHMgPSBvcHRpb25zLmNvbXBvbmVudHMsXG4gICAgICAgICAgICBwYXJ0aWFscyAgID0gb3B0aW9ucy5wYXJ0aWFscyxcbiAgICAgICAgICAgIHRlbXBsYXRlICAgPSBvcHRpb25zLnRlbXBsYXRlLFxuICAgICAgICAgICAgZmlsdGVycyAgICA9IG9wdGlvbnMuZmlsdGVycyxcbiAgICAgICAgICAgIGtleVxuICAgICAgICBpZiAoY29tcG9uZW50cykge1xuICAgICAgICAgICAgZm9yIChrZXkgaW4gY29tcG9uZW50cykge1xuICAgICAgICAgICAgICAgIGNvbXBvbmVudHNba2V5XSA9IHV0aWxzLnRvQ29uc3RydWN0b3IoY29tcG9uZW50c1trZXldKVxuICAgICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICAgIGlmIChwYXJ0aWFscykge1xuICAgICAgICAgICAgZm9yIChrZXkgaW4gcGFydGlhbHMpIHtcbiAgICAgICAgICAgICAgICBwYXJ0aWFsc1trZXldID0gdXRpbHMudG9GcmFnbWVudChwYXJ0aWFsc1trZXldKVxuICAgICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICAgIGlmIChmaWx0ZXJzKSB7XG4gICAgICAgICAgICBmb3IgKGtleSBpbiBmaWx0ZXJzKSB7XG4gICAgICAgICAgICAgICAgdXRpbHMuY2hlY2tGaWx0ZXIoZmlsdGVyc1trZXldKVxuICAgICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICAgIGlmICh0ZW1wbGF0ZSkge1xuICAgICAgICAgICAgb3B0aW9ucy50ZW1wbGF0ZSA9IHV0aWxzLnRvRnJhZ21lbnQodGVtcGxhdGUpXG4gICAgICAgIH1cbiAgICB9LFxuXG4gICAgLyoqXG4gICAgICogIHVzZWQgdG8gZGVmZXIgYmF0Y2ggdXBkYXRlc1xuICAgICAqL1xuICAgIG5leHRUaWNrOiBmdW5jdGlvbiAoY2IpIHtcbiAgICAgICAgdGltZW91dChjYiwgMClcbiAgICB9LFxuXG4gICAgLyoqXG4gICAgICogIGFkZCBjbGFzcyBmb3IgSUU5XG4gICAgICogIHVzZXMgY2xhc3NMaXN0IGlmIGF2YWlsYWJsZVxuICAgICAqL1xuICAgIGFkZENsYXNzOiBmdW5jdGlvbiAoZWwsIGNscykge1xuICAgICAgICBpZiAoaGFzQ2xhc3NMaXN0KSB7XG4gICAgICAgICAgICBlbC5jbGFzc0xpc3QuYWRkKGNscylcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIHZhciBjdXIgPSAnICcgKyBlbC5jbGFzc05hbWUgKyAnICdcbiAgICAgICAgICAgIGlmIChjdXIuaW5kZXhPZignICcgKyBjbHMgKyAnICcpIDwgMCkge1xuICAgICAgICAgICAgICAgIGVsLmNsYXNzTmFtZSA9IChjdXIgKyBjbHMpLnRyaW0oKVxuICAgICAgICAgICAgfVxuICAgICAgICB9XG4gICAgfSxcblxuICAgIC8qKlxuICAgICAqICByZW1vdmUgY2xhc3MgZm9yIElFOVxuICAgICAqL1xuICAgIHJlbW92ZUNsYXNzOiBmdW5jdGlvbiAoZWwsIGNscykge1xuICAgICAgICBpZiAoaGFzQ2xhc3NMaXN0KSB7XG4gICAgICAgICAgICBlbC5jbGFzc0xpc3QucmVtb3ZlKGNscylcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIHZhciBjdXIgPSAnICcgKyBlbC5jbGFzc05hbWUgKyAnICcsXG4gICAgICAgICAgICAgICAgdGFyID0gJyAnICsgY2xzICsgJyAnXG4gICAgICAgICAgICB3aGlsZSAoY3VyLmluZGV4T2YodGFyKSA+PSAwKSB7XG4gICAgICAgICAgICAgICAgY3VyID0gY3VyLnJlcGxhY2UodGFyLCAnICcpXG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBlbC5jbGFzc05hbWUgPSBjdXIudHJpbSgpXG4gICAgICAgIH1cbiAgICB9LFxuXG4gICAgLyoqXG4gICAgICogIENvbnZlcnQgYW4gb2JqZWN0IHRvIEFycmF5XG4gICAgICogIHVzZWQgaW4gdi1yZXBlYXQgYW5kIGFycmF5IGZpbHRlcnNcbiAgICAgKi9cbiAgICBvYmplY3RUb0FycmF5OiBmdW5jdGlvbiAob2JqKSB7XG4gICAgICAgIHZhciByZXMgPSBbXSwgdmFsLCBkYXRhXG4gICAgICAgIGZvciAodmFyIGtleSBpbiBvYmopIHtcbiAgICAgICAgICAgIHZhbCA9IG9ialtrZXldXG4gICAgICAgICAgICBkYXRhID0gdXRpbHMuaXNPYmplY3QodmFsKVxuICAgICAgICAgICAgICAgID8gdmFsXG4gICAgICAgICAgICAgICAgOiB7ICR2YWx1ZTogdmFsIH1cbiAgICAgICAgICAgIGRhdGEuJGtleSA9IGtleVxuICAgICAgICAgICAgcmVzLnB1c2goZGF0YSlcbiAgICAgICAgfVxuICAgICAgICByZXR1cm4gcmVzXG4gICAgfVxufVxuXG5lbmFibGVEZWJ1ZygpXG5mdW5jdGlvbiBlbmFibGVEZWJ1ZyAoKSB7XG4gICAgLyoqXG4gICAgICogIGxvZyBmb3IgZGVidWdnaW5nXG4gICAgICovXG4gICAgdXRpbHMubG9nID0gZnVuY3Rpb24gKG1zZykge1xuICAgICAgICBpZiAoY29uZmlnLmRlYnVnICYmIGNvbnNvbGUpIHtcbiAgICAgICAgICAgIGNvbnNvbGUubG9nKG1zZylcbiAgICAgICAgfVxuICAgIH1cbiAgICBcbiAgICAvKipcbiAgICAgKiAgd2FybmluZ3MsIHRyYWNlcyBieSBkZWZhdWx0XG4gICAgICogIGNhbiBiZSBzdXBwcmVzc2VkIGJ5IGBzaWxlbnRgIG9wdGlvbi5cbiAgICAgKi9cbiAgICB1dGlscy53YXJuID0gZnVuY3Rpb24gKG1zZykge1xuICAgICAgICBpZiAoIWNvbmZpZy5zaWxlbnQgJiYgY29uc29sZSkge1xuICAgICAgICAgICAgY29uc29sZS53YXJuKG1zZylcbiAgICAgICAgICAgIGlmIChjb25maWcuZGVidWcgJiYgY29uc29sZS50cmFjZSkge1xuICAgICAgICAgICAgICAgIGNvbnNvbGUudHJhY2UoKVxuICAgICAgICAgICAgfVxuICAgICAgICB9XG4gICAgfVxufSIsInZhciBDb21waWxlciAgID0gcmVxdWlyZSgnLi9jb21waWxlcicpLFxuICAgIHV0aWxzICAgICAgPSByZXF1aXJlKCcuL3V0aWxzJyksXG4gICAgdHJhbnNpdGlvbiA9IHJlcXVpcmUoJy4vdHJhbnNpdGlvbicpLFxuICAgIEJhdGNoZXIgICAgPSByZXF1aXJlKCcuL2JhdGNoZXInKSxcbiAgICBzbGljZSAgICAgID0gW10uc2xpY2UsXG4gICAgZGVmICAgICAgICA9IHV0aWxzLmRlZlByb3RlY3RlZCxcbiAgICBuZXh0VGljayAgID0gdXRpbHMubmV4dFRpY2ssXG5cbiAgICAvLyBiYXRjaCAkd2F0Y2ggY2FsbGJhY2tzXG4gICAgd2F0Y2hlckJhdGNoZXIgPSBuZXcgQmF0Y2hlcigpLFxuICAgIHdhdGNoZXJJZCAgICAgID0gMVxuXG4vKipcbiAqICBWaWV3TW9kZWwgZXhwb3NlZCB0byB0aGUgdXNlciB0aGF0IGhvbGRzIGRhdGEsXG4gKiAgY29tcHV0ZWQgcHJvcGVydGllcywgZXZlbnQgaGFuZGxlcnNcbiAqICBhbmQgYSBmZXcgcmVzZXJ2ZWQgbWV0aG9kc1xuICovXG5mdW5jdGlvbiBWaWV3TW9kZWwgKG9wdGlvbnMpIHtcbiAgICAvLyBqdXN0IGNvbXBpbGUuIG9wdGlvbnMgYXJlIHBhc3NlZCBkaXJlY3RseSB0byBjb21waWxlclxuICAgIG5ldyBDb21waWxlcih0aGlzLCBvcHRpb25zKVxufVxuXG4vLyBBbGwgVk0gcHJvdG90eXBlIG1ldGhvZHMgYXJlIGluZW51bWVyYWJsZVxuLy8gc28gaXQgY2FuIGJlIHN0cmluZ2lmaWVkL2xvb3BlZCB0aHJvdWdoIGFzIHJhdyBkYXRhXG52YXIgVk1Qcm90byA9IFZpZXdNb2RlbC5wcm90b3R5cGVcblxuLyoqXG4gKiAgQ29udmVuaWVuY2UgZnVuY3Rpb24gdG8gZ2V0IGEgdmFsdWUgZnJvbVxuICogIGEga2V5cGF0aFxuICovXG5kZWYoVk1Qcm90bywgJyRnZXQnLCBmdW5jdGlvbiAoa2V5KSB7XG4gICAgdmFyIHZhbCA9IHV0aWxzLmdldCh0aGlzLCBrZXkpXG4gICAgcmV0dXJuIHZhbCA9PT0gdW5kZWZpbmVkICYmIHRoaXMuJHBhcmVudFxuICAgICAgICA/IHRoaXMuJHBhcmVudC4kZ2V0KGtleSlcbiAgICAgICAgOiB2YWxcbn0pXG5cbi8qKlxuICogIENvbnZlbmllbmNlIGZ1bmN0aW9uIHRvIHNldCBhbiBhY3R1YWwgbmVzdGVkIHZhbHVlXG4gKiAgZnJvbSBhIGZsYXQga2V5IHN0cmluZy4gVXNlZCBpbiBkaXJlY3RpdmVzLlxuICovXG5kZWYoVk1Qcm90bywgJyRzZXQnLCBmdW5jdGlvbiAoa2V5LCB2YWx1ZSkge1xuICAgIHV0aWxzLnNldCh0aGlzLCBrZXksIHZhbHVlKVxufSlcblxuLyoqXG4gKiAgd2F0Y2ggYSBrZXkgb24gdGhlIHZpZXdtb2RlbCBmb3IgY2hhbmdlc1xuICogIGZpcmUgY2FsbGJhY2sgd2l0aCBuZXcgdmFsdWVcbiAqL1xuZGVmKFZNUHJvdG8sICckd2F0Y2gnLCBmdW5jdGlvbiAoa2V5LCBjYWxsYmFjaykge1xuICAgIC8vIHNhdmUgYSB1bmlxdWUgaWQgZm9yIGVhY2ggd2F0Y2hlclxuICAgIHZhciBpZCA9IHdhdGNoZXJJZCsrLFxuICAgICAgICBzZWxmID0gdGhpc1xuICAgIGZ1bmN0aW9uIG9uICgpIHtcbiAgICAgICAgdmFyIGFyZ3MgPSBzbGljZS5jYWxsKGFyZ3VtZW50cylcbiAgICAgICAgd2F0Y2hlckJhdGNoZXIucHVzaCh7XG4gICAgICAgICAgICBpZDogaWQsXG4gICAgICAgICAgICBvdmVycmlkZTogdHJ1ZSxcbiAgICAgICAgICAgIGV4ZWN1dGU6IGZ1bmN0aW9uICgpIHtcbiAgICAgICAgICAgICAgICBjYWxsYmFjay5hcHBseShzZWxmLCBhcmdzKVxuICAgICAgICAgICAgfVxuICAgICAgICB9KVxuICAgIH1cbiAgICBjYWxsYmFjay5fZm4gPSBvblxuICAgIHNlbGYuJGNvbXBpbGVyLm9ic2VydmVyLm9uKCdjaGFuZ2U6JyArIGtleSwgb24pXG59KVxuXG4vKipcbiAqICB1bndhdGNoIGEga2V5XG4gKi9cbmRlZihWTVByb3RvLCAnJHVud2F0Y2gnLCBmdW5jdGlvbiAoa2V5LCBjYWxsYmFjaykge1xuICAgIC8vIHdvcmthcm91bmQgaGVyZVxuICAgIC8vIHNpbmNlIHRoZSBlbWl0dGVyIG1vZHVsZSBjaGVja3MgY2FsbGJhY2sgZXhpc3RlbmNlXG4gICAgLy8gYnkgY2hlY2tpbmcgdGhlIGxlbmd0aCBvZiBhcmd1bWVudHNcbiAgICB2YXIgYXJncyA9IFsnY2hhbmdlOicgKyBrZXldLFxuICAgICAgICBvYiA9IHRoaXMuJGNvbXBpbGVyLm9ic2VydmVyXG4gICAgaWYgKGNhbGxiYWNrKSBhcmdzLnB1c2goY2FsbGJhY2suX2ZuKVxuICAgIG9iLm9mZi5hcHBseShvYiwgYXJncylcbn0pXG5cbi8qKlxuICogIHVuYmluZCBldmVyeXRoaW5nLCByZW1vdmUgZXZlcnl0aGluZ1xuICovXG5kZWYoVk1Qcm90bywgJyRkZXN0cm95JywgZnVuY3Rpb24gKCkge1xuICAgIHRoaXMuJGNvbXBpbGVyLmRlc3Ryb3koKVxufSlcblxuLyoqXG4gKiAgYnJvYWRjYXN0IGFuIGV2ZW50IHRvIGFsbCBjaGlsZCBWTXMgcmVjdXJzaXZlbHkuXG4gKi9cbmRlZihWTVByb3RvLCAnJGJyb2FkY2FzdCcsIGZ1bmN0aW9uICgpIHtcbiAgICB2YXIgY2hpbGRyZW4gPSB0aGlzLiRjb21waWxlci5jaGlsZHJlbixcbiAgICAgICAgaSA9IGNoaWxkcmVuLmxlbmd0aCxcbiAgICAgICAgY2hpbGRcbiAgICB3aGlsZSAoaS0tKSB7XG4gICAgICAgIGNoaWxkID0gY2hpbGRyZW5baV1cbiAgICAgICAgY2hpbGQuZW1pdHRlci5lbWl0LmFwcGx5KGNoaWxkLmVtaXR0ZXIsIGFyZ3VtZW50cylcbiAgICAgICAgY2hpbGQudm0uJGJyb2FkY2FzdC5hcHBseShjaGlsZC52bSwgYXJndW1lbnRzKVxuICAgIH1cbn0pXG5cbi8qKlxuICogIGVtaXQgYW4gZXZlbnQgdGhhdCBwcm9wYWdhdGVzIGFsbCB0aGUgd2F5IHVwIHRvIHBhcmVudCBWTXMuXG4gKi9cbmRlZihWTVByb3RvLCAnJGRpc3BhdGNoJywgZnVuY3Rpb24gKCkge1xuICAgIHZhciBjb21waWxlciA9IHRoaXMuJGNvbXBpbGVyLFxuICAgICAgICBlbWl0dGVyID0gY29tcGlsZXIuZW1pdHRlcixcbiAgICAgICAgcGFyZW50ID0gY29tcGlsZXIucGFyZW50XG4gICAgZW1pdHRlci5lbWl0LmFwcGx5KGVtaXR0ZXIsIGFyZ3VtZW50cylcbiAgICBpZiAocGFyZW50KSB7XG4gICAgICAgIHBhcmVudC52bS4kZGlzcGF0Y2guYXBwbHkocGFyZW50LnZtLCBhcmd1bWVudHMpXG4gICAgfVxufSlcblxuLyoqXG4gKiAgZGVsZWdhdGUgb24vb2ZmL29uY2UgdG8gdGhlIGNvbXBpbGVyJ3MgZW1pdHRlclxuICovXG47WydlbWl0JywgJ29uJywgJ29mZicsICdvbmNlJ10uZm9yRWFjaChmdW5jdGlvbiAobWV0aG9kKSB7XG4gICAgZGVmKFZNUHJvdG8sICckJyArIG1ldGhvZCwgZnVuY3Rpb24gKCkge1xuICAgICAgICB2YXIgZW1pdHRlciA9IHRoaXMuJGNvbXBpbGVyLmVtaXR0ZXJcbiAgICAgICAgZW1pdHRlclttZXRob2RdLmFwcGx5KGVtaXR0ZXIsIGFyZ3VtZW50cylcbiAgICB9KVxufSlcblxuLy8gRE9NIGNvbnZlbmllbmNlIG1ldGhvZHNcblxuZGVmKFZNUHJvdG8sICckYXBwZW5kVG8nLCBmdW5jdGlvbiAodGFyZ2V0LCBjYikge1xuICAgIHRhcmdldCA9IHF1ZXJ5KHRhcmdldClcbiAgICB2YXIgZWwgPSB0aGlzLiRlbFxuICAgIHRyYW5zaXRpb24oZWwsIDEsIGZ1bmN0aW9uICgpIHtcbiAgICAgICAgdGFyZ2V0LmFwcGVuZENoaWxkKGVsKVxuICAgICAgICBpZiAoY2IpIG5leHRUaWNrKGNiKVxuICAgIH0sIHRoaXMuJGNvbXBpbGVyKVxufSlcblxuZGVmKFZNUHJvdG8sICckcmVtb3ZlJywgZnVuY3Rpb24gKGNiKSB7XG4gICAgdmFyIGVsID0gdGhpcy4kZWxcbiAgICB0cmFuc2l0aW9uKGVsLCAtMSwgZnVuY3Rpb24gKCkge1xuICAgICAgICBpZiAoZWwucGFyZW50Tm9kZSkge1xuICAgICAgICAgICAgZWwucGFyZW50Tm9kZS5yZW1vdmVDaGlsZChlbClcbiAgICAgICAgfVxuICAgICAgICBpZiAoY2IpIG5leHRUaWNrKGNiKVxuICAgIH0sIHRoaXMuJGNvbXBpbGVyKVxufSlcblxuZGVmKFZNUHJvdG8sICckYmVmb3JlJywgZnVuY3Rpb24gKHRhcmdldCwgY2IpIHtcbiAgICB0YXJnZXQgPSBxdWVyeSh0YXJnZXQpXG4gICAgdmFyIGVsID0gdGhpcy4kZWxcbiAgICB0cmFuc2l0aW9uKGVsLCAxLCBmdW5jdGlvbiAoKSB7XG4gICAgICAgIHRhcmdldC5wYXJlbnROb2RlLmluc2VydEJlZm9yZShlbCwgdGFyZ2V0KVxuICAgICAgICBpZiAoY2IpIG5leHRUaWNrKGNiKVxuICAgIH0sIHRoaXMuJGNvbXBpbGVyKVxufSlcblxuZGVmKFZNUHJvdG8sICckYWZ0ZXInLCBmdW5jdGlvbiAodGFyZ2V0LCBjYikge1xuICAgIHRhcmdldCA9IHF1ZXJ5KHRhcmdldClcbiAgICB2YXIgZWwgPSB0aGlzLiRlbFxuICAgIHRyYW5zaXRpb24oZWwsIDEsIGZ1bmN0aW9uICgpIHtcbiAgICAgICAgaWYgKHRhcmdldC5uZXh0U2libGluZykge1xuICAgICAgICAgICAgdGFyZ2V0LnBhcmVudE5vZGUuaW5zZXJ0QmVmb3JlKGVsLCB0YXJnZXQubmV4dFNpYmxpbmcpXG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICB0YXJnZXQucGFyZW50Tm9kZS5hcHBlbmRDaGlsZChlbClcbiAgICAgICAgfVxuICAgICAgICBpZiAoY2IpIG5leHRUaWNrKGNiKVxuICAgIH0sIHRoaXMuJGNvbXBpbGVyKVxufSlcblxuZnVuY3Rpb24gcXVlcnkgKGVsKSB7XG4gICAgcmV0dXJuIHR5cGVvZiBlbCA9PT0gJ3N0cmluZydcbiAgICAgICAgPyBkb2N1bWVudC5xdWVyeVNlbGVjdG9yKGVsKVxuICAgICAgICA6IGVsXG59XG5cbm1vZHVsZS5leHBvcnRzID0gVmlld01vZGVsIiwibW9kdWxlLmV4cG9ydHMgPSAnI2FwcCB7XFxuICAgIGZvbnQtZmFtaWx5OiBcXCdIZWx2ZXRpY2EgTmV1ZVxcJywgQXJpYWwsIHNhbnMtc2VyaWY7XFxufSc7IiwibW9kdWxlLmV4cG9ydHMgPSAnPGgxPnt7dGl0bGV9fTwvaDE+XFxuPGNvbXBvbmVudC1idXR0b24+YnV0dG9uPC9jb21wb25lbnQtYnV0dG9uPlxcbjxjb21wb25lbnQtcGFuZWw+XFxuICA8cD5IZXJlIGlzIHNvbWUgY29udGVudCBzcGVjaWZpZWQgd2l0aGluIHRoZSBwYW5lbDwvcD5cXG4gIDxjb21wb25lbnQtYnV0dG9uPnN1Ym1pdDwvY29tcG9uZW50LWJ1dHRvbj5cXG48L2NvbXBvbmVudC1wYW5lbD4nOyIsInJlcXVpcmUoJ2luc2VydC1jc3MnKShyZXF1aXJlKCcuL3N0eWxlLmNzcycpKVxuXG5tb2R1bGUuZXhwb3J0cyA9IHtcbiAgICB0YWdOYW1lOiAnY29tcG9uZW50LWJ1dHRvbicsXG4gICAgdGVtcGxhdGU6IHJlcXVpcmUoJy4vdGVtcGxhdGUuaHRtbCcpLFxuICAgIGRhdGE6IHtcbiAgICAgICAgbGFiZWw6ICdCdXR0b24hJ1xuICAgIH0sXG4gICAgcmVwbGFjZTp0cnVlXG59IiwibW9kdWxlLmV4cG9ydHMgPSAnLmNvbXBvbmVudC1idXR0b24ge1xcbiAgICBtYXJnaW46IDNweDtcXG59JzsiLCJtb2R1bGUuZXhwb3J0cyA9ICc8YnV0dG9uPjxjb250ZW50PkRlZmF1bHQgTGFiZWw8L2NvbnRlbnQ+PC9idXR0b24+JzsiLCJyZXF1aXJlKCdpbnNlcnQtY3NzJykocmVxdWlyZSgnLi9zdHlsZS5jc3MnKSlcblxubW9kdWxlLmV4cG9ydHMgPSB7XG4gICAgdGFnTmFtZTogJ2NvbXBvbmVudC1wYW5lbCcsXG4gICAgY2xhc3NOYW1lOiAnY29tcG9uZW50LXBhbmVsJyxcbiAgICB0ZW1wbGF0ZTogcmVxdWlyZSgnLi90ZW1wbGF0ZS5odG1sJyksXG4gICAgZGF0YToge1xuICAgICAgICBoZWFkZXJUZXh0OiAnSGVhZGVyIEluZm8nLFxuICAgICAgICBib2R5Q29udGVudDogJydcbiAgICB9LFxuICAgIGNyZWF0ZWQ6IGZ1bmN0aW9uKCkge1xuICAgICAgY29uc29sZS5sb2codGhpcy4kY29tcGlsZXIucmF3Q29udGVudC5pbm5lckhUTUwpO1xuICAgICAgdGhpcy5ib2R5Q29udGVudCA9IHRoaXMuJGNvbXBpbGVyLnJhd0NvbnRlbnQuaW5uZXJIVE1MO1xuICAgIH1cbn0iLCJtb2R1bGUuZXhwb3J0cyA9ICcuY29tcG9uZW50LXBhbmVsIHtcXG4gICAgYm9yZGVyOiAxcHggc29saWQgZ3JleTtcXG4gICAgcGFkZGluZzogMTBweDtcXG4gICAgZGlzcGxheTogYmxvY2s7XFxufSc7IiwibW9kdWxlLmV4cG9ydHMgPSAnPGRpdj5cXG4gIDxoMz5UaGUgZm9sbG93aW5nIGlzIGluc2VydGVkIHZpYSBjb250ZW50IGluc2VydGlvbi48L2gzPlxcbiAgPGNvbnRlbnQ+VGhpcyB3aWxsIG9ubHkgYmUgZGlzcGxheWVkIGlmIG5vIGNvbnRlbnQgaXMgaW5zZXJ0ZWQ8L2NvbnRlbnQ+XFxuICA8aDM+VGhlIGZvbGxvd2luZyBpcyBpbnNlcnRlZCB2aWEgZGF0YSBiaW5kaW5nPC9oMz5cXG4gIHt7e2JvZHlDb250ZW50fX19XFxuPC9kaXY+XFxuXFxuJzsiLCJyZXF1aXJlKCdpbnNlcnQtY3NzJykocmVxdWlyZSgnLi9hcHAuY3NzJykpXG5cbnZhciBWdWUgPSByZXF1aXJlKCd2dWUnKVxuXG5uZXcgVnVlKHtcbiAgICBlbDogJyNhcHAnLFxuICAgIGNvbXBvbmVudHM6IHtcbiAgICAgICAgXCJjb21wb25lbnQtYnV0dG9uXCI6IHJlcXVpcmUoJy4vY29tcG9uZW50LWJ1dHRvbicpLFxuICAgICAgICBcImNvbXBvbmVudC1wYW5lbFwiOiByZXF1aXJlKCcuL2NvbXBvbmVudC1wYW5lbCcpXG4gICAgfSxcbiAgICAvLyByZXF1aXJlIGh0bWwgZW5hYmxlZCBieSB0aGUgcGFydGlhbGlmeSB0cmFuc2Zvcm1cbiAgICB0ZW1wbGF0ZTogcmVxdWlyZSgnLi9hcHAuaHRtbCcpLFxuICAgIGRhdGE6IHtcbiAgICAgICAgdGl0bGU6ICdWdWUgY29udGVudCBpbnNlcnRpb24gdGVzdCdcbiAgICB9XG59KSJdfQ==
