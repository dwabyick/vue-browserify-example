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