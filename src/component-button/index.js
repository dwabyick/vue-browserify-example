require('insert-css')(require('./style.css'))

module.exports = {
    tagName: 'component-button',
    template: require('./template.html'),
    data: {
        label: 'Button!'
    },
    replace:true
}